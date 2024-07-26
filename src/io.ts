import {
    BlobReader,
    BlobWriter,
    Entry,
    EntryGetDataOptions,
    Reader,
    Writer,
} from "@zip.js/zip.js";
import {
    EntryMetadata,
    getEntryMetadata,
    logDebug,
    zipGetData,
} from "./common";

function parseIndex(index: number, size: number) {
    return index < 0 ?
        Math.max(index + size, 0) :
        Math.min(index, size);
}

class BlobEntryReaderImpl extends Reader<Blob> {
    private readonly blob: Blob;
    private readonly offset: number;

    constructor(blob: Blob, entryMetadata: EntryMetadata) {
        super(blob);

        this.blob = blob;
        this.offset = entryMetadata.offset + entryMetadata.headerSize;
        this.size = entryMetadata.compressedSize;
    }

    async readUint8Array(index: number, length: number): Promise<Uint8Array> {
        const start = parseIndex(index, this.size) + this.offset;
        const end = parseIndex(index + length, this.size) + this.offset;
        const blob = this.blob.slice(start, end);
        return new Uint8Array(await blob.arrayBuffer());
    }
}

/**
 * Represents a {@link Reader} instance used to read data of an entry in a zip
 * file provided as a {@link Blob}. It directly reads data if it is uncompressed.
 */
export class BlobEntryReader extends Reader<void> {
    private readonly blob: Blob;
    private readonly entry: Entry;
    private readonly mimeString: string | undefined;
    private readonly options: EntryGetDataOptions | undefined;

    private reader: Reader<Blob> | undefined;

    /**
     * @param blob - The blob to read data from, usually the outer zip file.
     * @param entry - The entry to read data of, usually the inner zip file.
     * @param mimeString - The MIME type of the data.
     * @param options - Represents options passed to {@link Entry#getData}.
     */
    constructor(
        blob: Blob,
        entry: Entry,
        mimeString?: string,
        options?: EntryGetDataOptions
    ) {
        super();

        this.blob = blob;
        this.entry = entry;
        this.mimeString = mimeString;
        this.options = options;
    }

    async init(): Promise<void> {
        const entryMetadata = await getEntryMetadata(this.blob, this.entry);

        if (entryMetadata.compressionMethod !== 0) {
            const entryBlob: Blob = await zipGetData(
                this.entry,
                new BlobWriter(this.mimeString),
                this.options
            );
            this.reader = new BlobReader(entryBlob);
        } else {
            this.reader = new BlobEntryReaderImpl(this.blob, entryMetadata);
        }

        this.size = this.reader.size;
    }

    async readUint8Array(index: number, length: number): Promise<Uint8Array> {
        return this.reader!.readUint8Array(index, length);
    }
}

/**
 * ChunkedWriter splits a stream into chunks and passes them to the consumer. Note that the final
 * chunk will be smaller than the requested chunk size if the stream length is not evenly divisible
 * by chunk size.
 */
export class ChunkedWriter extends Writer<number> {
    private pendingChunk: Uint8Array;
    private pendingChunkOffset = 0;

    private streamOffset = 0;

    constructor(
        chunkSize: number,
        readonly consumer: (buf: ArrayBuffer) => Promise<void>,
        readonly streamLength: number
    ) {
        super();
        this.pendingChunk = new Uint8Array(chunkSize);
    }

    async init(size?: number) {
        if (this.streamLength !== size) {
            throw new Error(`size (${size}) != streamLength (${this.streamLength}`);
        }
    }

    private async sendToConsumer(buf: ArrayBuffer) {
        await this.consumer(buf);
        this.streamOffset += buf.byteLength;
    }

    async writeUint8Array(array: Uint8Array) {
        let arrayOff = 0;
        const arrayLen = array.length;
        const chunkLen = this.pendingChunk.length;

        while (arrayOff < arrayLen) {
            const arrayRem = arrayLen - arrayOff;
            if (this.pendingChunkOffset > 0 || arrayRem < chunkLen) {
                const chunkRem = chunkLen - this.pendingChunkOffset;
                if (chunkRem <= arrayRem) {
                    this.pendingChunk.set(
                        array.slice(arrayOff, arrayOff + chunkRem),
                        this.pendingChunkOffset
                    );
                    arrayOff += chunkRem;
                    this.pendingChunkOffset = 0;
                    await this.sendToConsumer(this.pendingChunk);
                    continue;
                } else {
                    this.pendingChunk.set(
                        array.slice(arrayOff, arrayOff + arrayRem),
                        this.pendingChunkOffset
                    );
                    arrayOff += arrayRem;
                    this.pendingChunkOffset += arrayRem;
                    break;
                }
            }
            await this.sendToConsumer(array.slice(arrayOff, arrayOff + chunkLen));
            arrayOff += chunkLen;
        }

        if (this.streamOffset + this.pendingChunkOffset > this.streamLength) {
            throw new Error(
                `streamOffset overflow: streamOffset ${this.streamOffset},` +
                 ` pendingChunkOffset ${this.pendingChunkOffset}, streamLength ${this.streamLength}`
            );
        }

        if (
            this.pendingChunkOffset !== 0 &&
            this.streamOffset + this.pendingChunkOffset === this.streamLength
        ) {
            logDebug(
                `ChunkedWriter: sending remainder: ${this.pendingChunkOffset} bytes, streamLength: ${this.streamLength} bytes`
            );
            await this.sendToConsumer(this.pendingChunk.slice(0, this.pendingChunkOffset));
            this.pendingChunkOffset = 0;
        }
    }

    async getData() {
        return this.streamOffset;
    }
}
