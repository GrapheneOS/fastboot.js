import { EntryMetadata, getEntryMetadata, zipGetData } from "./common";
import { BlobReader, BlobWriter, Entry, EntryGetDataOptions, Reader } from "@zip.js/zip.js";

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
