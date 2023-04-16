import { EntryMetadata, getEntryMetadata, zipGetData } from "./common";
import { BlobReader, BlobWriter, Entry, EntryGetDataOptions, Reader } from "@zip.js/zip.js";

function parseOffset(offset: number, size: number) {
    return offset < 0 ?
        Math.max(size + offset, 0) :
        Math.min(offset, size);
}

class UncompressedEntryReader extends Reader {
    private readonly blob: Blob;
    private readonly offset: number;

    constructor(blob: Blob, entryMetadata: EntryMetadata) {
        super();

        this.blob = blob;
        this.offset = entryMetadata.offset + entryMetadata.localFileHeaderSize;
        this.size = entryMetadata.compressedSize;
    }

    async readUint8Array(offset: number, length: number): Promise<Uint8Array> {
        const reader = this;
        const start = parseOffset(offset, reader.size) + reader.offset;
        const end = parseOffset(offset + length, reader.size) + reader.offset;
        const blob = reader.blob.slice(start, end);
        return new Uint8Array(await blob.arrayBuffer());
    }
}

/**
 * Represents a {@link Reader} instance used to read data of an entry in a zip
 * file provided as a {@link Blob}. It directly reads data if it is uncompressed.
 */
export class BlobEntryReader extends Reader {
    private readonly reader: Reader;

    private constructor(blob: Blob, entryMetadata?: EntryMetadata) {
        super();

        if (!entryMetadata) {
            this.reader = new BlobReader(blob);
        } else {
            this.reader = new UncompressedEntryReader(blob, entryMetadata);
        }

        this.size = this.reader.size;
    }

    /**
     * @param blob - The blob to read data from, usually the outer zip file.
     * @param entry - The entry to read data of, usually the inner zip file.
     * @param options - Options to pass to {@link zipGetData} if the entry data needs to be extracted first.
     */
    static async new(blob: Blob, entry: Entry, options?: EntryGetDataOptions): Promise<BlobEntryReader> {
        const entryMetadata = await getEntryMetadata(blob, entry);

        // Extract the entry data first if it is compressed.
        if (entryMetadata.compressionMethod !== 0) {
            const entryBlob = await zipGetData(
                entry,
                new BlobWriter("application/zip"),
                options
            );
            return new BlobEntryReader(entryBlob);
        }

        return new BlobEntryReader(blob, entryMetadata);
    }

    async readUint8Array(offset: number, length: number): Promise<Uint8Array> {
        return this.reader.readUint8Array(offset, length);
    }
}
