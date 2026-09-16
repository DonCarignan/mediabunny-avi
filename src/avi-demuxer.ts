/*!
 * Copyright (c) 2026-present, Don Carignan and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import {
	PCM_AUDIO_CODECS,
	AudioCodec,
	BaseCustomTrack,
	CustomAudioTrack,
	CustomDemuxer,
	CustomTrack,
	CustomVideoTrack,
	DemuxerContext,
	EncodedPacket,
	FileSlice,
	InputDisposedError,
	MetadataTags,
	PacketRetrievalOptions,
	readAscii,
	readBytes,
	readI32Le,
	readU16,
	readU32Le,
	readU64,
	VideoCodec,
} from 'mediabunny';

type AviPacket = {
	pos: number;
	size: number;
	segments?: { pos: number; size: number }[];
	key: boolean;
	timestamp: number;
	duration: number;
};

type AviStream = {
	type: string;
	exposed: boolean;
	handler: string;
	flags: number;
	scale: number;
	rate: number;
	start: number;
	length: number;
	sampleSize: number;
	format: FileSlice | null;
	name: string | null;
	indexes: { pos: number; size: number }[];
	packets: AviPacket[];
};

type MoviRange = { start: number; end: number };

type MoviChunk = { pos: number; id: string; size: number };

type MoviLayout = { chunks: MoviChunk[]; unknown: MoviRange[] };

// Assumes items is sorted by key
/** How much to read at once when walking a run of small fixed-size records. */
const READ_WINDOW = 1 << 16;

const lastIndexAtOrBefore = <T>(items: T[], key: (item: T) => number, value: number) => {
	let low = 0;
	let high = items.length;
	while (low < high) {
		const mid = (low + high) >>> 1;
		if (key(items[mid]!) <= value) {
			low = mid + 1;
		} else {
			high = mid;
		}
	}
	return low - 1;
};

export class AviDemuxer implements CustomDemuxer {
	metadataPromise: Promise<void> | null = null;
	streams: AviStream[] = [];
	moviRanges: MoviRange[] = [];
	moviLayout: MoviLayout | null = null;
	oldIndexes: { pos: number; size: number; base: number }[] = [];
	tracks: CustomTrack[] = [];
	metadataTags: MetadataTags = {};
	indexValid = true;
	openDmlStreams = new Set<AviStream>();
	mustUseIndex = false;

	constructor(public context: DemuxerContext) {}

	async getTracks() {
		await this.readMetadata();
		return this.tracks;
	}

	getMimeType() {
		return 'video/x-msvideo';
	}

	async getMetadataTags() {
		await this.readMetadata();
		return this.metadataTags;
	}

	// https://github.com/MicrosoftDocs/win32/blob/docs/desktop-src/DirectShow/avi-riff-file-reference.md
	async readMetadata() {
		return this.metadataPromise ??= (async () => {
			let currentPos = 0;
			while (true) {
				let slice = this.context.reader.requestSlice(currentPos, 12);
				if (slice instanceof Promise) {
					slice = await slice;
				}
				if (!slice) {
					break;
				}

				const chunkId = readAscii(slice, 4);
				const outerChunkSize = readU32Le(slice);
				const chunkType = readAscii(slice, 4);

				if (currentPos > 0 && chunkId !== 'RIFF') {
					if (chunkId === 'JUNK') {
						currentPos += 8 + outerChunkSize + (outerChunkSize & 1);
						continue;
					}
					// Some writers leave junk after the last RIFF chunk, so let's stop here
					break;
				}

				if (chunkId !== 'RIFF' || chunkType !== (currentPos === 0 ? 'AVI ' : 'AVIX') || outerChunkSize < 4) {
					throw new Error('Invalid AVI file - wrong RIFF header');
				}

				const end = Math.min(currentPos + 8 + outerChunkSize, this.context.reader.fileSize ?? Infinity);
				await this.readChunks(currentPos + 12, end, 0);

				currentPos += 8 + outerChunkSize + (outerChunkSize & 1);
				if (currentPos >= (this.context.reader.fileSize ?? Infinity)) {
					break;
				}
			}
			if (this.streams.length === 0 || this.moviRanges.length === 0) {
				throw new Error('Invalid AVI file - missing stream headers or movi list');
			}
			if (this.streams.every(stream => !stream.exposed)) {
				// Reading the indexes or walking the movi lists can read the whole file, and neither can produce a
				// track when no stream has a type we expose
				return;
			}

			for (const stream of this.streams) {
				if (!stream.exposed) {
					continue;
				}

				// One set per stream: a cycle can span two of its index chunks
				const visited = new Set<number>();
				for (const index of stream.indexes) {
					await this.readIndex(stream, index.pos, index.size, visited);
				}
			}

			this.openDmlStreams = new Set(this.streams.filter(stream => stream.packets.length > 0));
			for (const index of this.oldIndexes) {
				await this.readOldIndex(index.pos, index.size, index.base);
			}

			const hasMissingPackets = this.streams.some((stream) => {
				if (!stream.exposed) {
					return false;
				}
				if (stream.packets.length === 0) {
					// An index that exists and simply has no entries for this stream says the stream is empty.
					// Only the absence of any index makes an empty stream evidence of one we failed to read
					return this.oldIndexes.length === 0 && stream.indexes.length === 0;
				}
				if (stream.sampleSize === 0) {
					return stream.packets.length < stream.length;
				}

				const totalSize = stream.packets.reduce((sum, packet) => sum + packet.size, 0);
				return totalSize < stream.length * stream.sampleSize;
			});
			if (!this.indexValid || hasMissingPackets) {
				if (this.mustUseIndex) {
					throw new Error('AVI requires an index, but its index is missing, invalid or unsupported.');
				}
				// Let's keep the keyframe flags from the entries we could read
				const keyframeFlags = new Map<number, boolean>();
				for (const stream of this.streams) {
					for (const packet of stream.packets) {
						keyframeFlags.set(packet.pos, packet.key);
					}
				}
				for (const stream of this.streams) {
					stream.packets = [];
				}
				// If the tolerant walk already mapped every byte, a strict walk would find the same chunks
				const layout = this.moviLayout?.unknown.length === 0
					? this.moviLayout
					: await this.readMoviLayout(true);
				for (const chunk of layout.chunks) {
					const stream = this.streamForChunk(chunk.id);
					if (stream) {
						stream.packets.push({
							pos: chunk.pos, size: chunk.size,
							key: keyframeFlags.get(chunk.pos) ?? (chunk.id.endsWith('wb') || chunk.id.endsWith('db')),
							timestamp: 0, duration: 0,
						});
					}
				}
			}
			this.moviLayout = null;

			for (const [i, stream] of this.streams.entries()) {
				if (!stream.exposed) {
					continue;
				}

				if (!stream.scale || !stream.rate || !stream.format) {
					throw new Error('Invalid AVI stream header');
				}

				let units = stream.start;
				for (const packet of stream.packets) {
					const count = stream.sampleSize ? packet.size / stream.sampleSize : 1;
					packet.timestamp = units * stream.scale / stream.rate;
					packet.duration = count * stream.scale / stream.rate;
					units += count;
				}

				if (stream.type === 'vids') {
					const packets: AviPacket[] = [];
					for (const packet of stream.packets) {
						if (packet.size > 0) {
							packets.push(packet);
						} else {
							// Empty chunk, so keep showing the previous frame for another interval
							const previous = packets[packets.length - 1];
							if (previous) {
								previous.duration += packet.duration;
							}
						}
					}
					stream.packets = packets;
				}

				// A video track we cannot serve honestly is dropped rather than failing the whole file, which
				// leaves the audio and the metadata tags of a file whose video we cannot describe
				const track = stream.type === 'vids'
					? await this.createVideoTrack(stream, i)
					: await this.createAudioTrack(stream, i);
				if (track) {
					this.tracks.push(track);
				}
				// The header slice pins whatever the reader cached around it, and nothing needs it after this
				stream.format = null;
			}
		})().finally(() => {
			// The layout is scaffolding for reading the indexes. The happy path drops it above; this also drops
			// it when we failed, since the caller may keep the input around
			this.moviLayout = null;
		});
	}

	private async readChunks(start: number, end: number, depth: number, stream?: AviStream) {
		if (depth > 16) {
			throw new Error('AVI lists are nested too deeply.');
		}
		let moviBase = 0;
		for (let pos = start; pos + 8 <= end;) {
			let slice = this.context.reader.requestSlice(pos, 8);
			if (slice instanceof Promise) {
				slice = await slice;
			}
			if (!slice) {
				break;
			}
			const id = readAscii(slice, 4);
			let size = readU32Le(slice);
			const dataPos = pos + 8;
			const dataEnd = Math.min(dataPos + size, end);
			if (dataPos + size > end && id !== 'LIST' && id !== 'idx1') {
				throw new Error('AVI chunk extends past its containing list.');
			}
			size = dataEnd - dataPos;
			if (id === 'LIST') {
				const typeSlice = await this.context.reader.requestSlice(dataPos, 4);
				if (size < 4 || !typeSlice) {
					throw new Error('Invalid AVI list');
				}
				const type = readAscii(typeSlice, 4);
				if (type === 'movi') {
					moviBase = dataPos;
					this.moviRanges.push({ start: dataPos + 4, end: dataEnd });
				} else if (type === 'strl') {
					const next: AviStream = {
						type: '', exposed: false, handler: '', flags: 0, scale: 0, rate: 0, start: 0, length: 0,
						sampleSize: 0,
						format: null, name: null, indexes: [], packets: [],
					};
					this.streams.push(next);
					await this.readChunks(dataPos + 4, dataEnd, depth + 1, next);
				} else if (type === 'INFO') {
					await this.readInfo(dataPos + 4, dataEnd);
				} else {
					await this.readChunks(dataPos + 4, dataEnd, depth + 1, stream);
				}
			} else if (id === 'avih') {
				const header = await this.context.reader.requestSlice(dataPos, Math.min(size, 56));
				if (!header || header.length < 56) {
					throw new Error('Invalid AVI main header');
				}
				header.skip(12);
				this.mustUseIndex = !!(readU32Le(header) & 0x20);
			} else if (id === 'strh' && stream) {
				const header = await this.context.reader.requestSlice(dataPos, Math.min(size, 56));
				if (!header || header.length < 48) {
					throw new Error('Invalid AVI stream header');
				}
				stream.type = readAscii(header, 4);
				stream.exposed = stream.type === 'vids' || stream.type === 'auds';
				stream.handler = readAscii(header, 4);
				stream.flags = readU32Le(header);
				header.skip(8); // Priority, language and initial frames
				stream.scale = readU32Le(header);
				stream.rate = readU32Le(header);
				stream.start = readU32Le(header);
				stream.length = readU32Le(header);
				header.skip(8); // Suggested buffer size and quality
				stream.sampleSize = readU32Le(header);
			} else if (id === 'strf' && stream) {
				if (size > 1024 * 1024) {
					throw new Error('AVI stream format is too large.');
				}
				stream.format = await this.context.reader.requestSlice(dataPos, size);
			} else if (id === 'strn' && stream) {
				const nameSize = Math.min(size, 65536);
				const name = await this.context.reader.requestSlice(dataPos, nameSize);
				stream.name = name ? readAscii(name, nameSize).replace(/\0.*$/s, '') : null;
			} else if (id === 'indx' && stream) {
				stream.indexes.push({ pos: dataPos, size });
			} else if (id === 'idx1') {
				this.oldIndexes.push({ pos: dataPos, size: dataEnd - dataPos, base: moviBase });
			}
			pos = dataPos + size + (size & 1); // Handle padding
		}
	}

	private async readInfo(start: number, end: number) {
		const names: Record<string, keyof MetadataTags> = {
			INAM: 'title', IART: 'artist', ICMT: 'comment', IPRD: 'album', IGNR: 'genre',
		};
		for (let pos = start; pos + 8 <= end;) {
			const header = await this.context.reader.requestSlice(pos, 8);
			if (!header) {
				break;
			}
			const id = readAscii(header, 4);
			const size = readU32Le(header);
			if (pos + 8 + size > end) {
				break;
			}
			const value = size <= 1024 * 1024 ? await this.context.reader.requestSlice(pos + 8, size) : null;
			if (value) {
				const text = readAscii(value, size).replace(/\0.*$/s, '');
				this.metadataTags.raw ??= {};
				this.metadataTags.raw[id] = text;
				const name = names[id];
				if (name) {
					Object.assign(this.metadataTags, { [name]: text });
				}
			}
			pos += 8 + size + (size & 1);
		}
	}

	private streamForChunk(id: string) {
		// AVI stream numbers are decimal, including streams past nine. Writers differ on the case of the two-cc
		if (!/^\d{2}(?:dc|db|wb)$/i.test(id)) {
			return undefined;
		}
		// A stream we cannot expose must not own a chunk: its index entries would otherwise be validated, and one
		// bad entry for a stream nobody reads would discard the index for the streams that are read
		const stream = this.streams[Number(id.slice(0, 2))];
		return stream?.exposed ? stream : undefined;
	}

	// An index only says where a packet should be, so we walk the movi lists once to see what is really there. A
	// strict walk rejects malformed lists, a tolerant one only records what it could not map.
	private async readMoviChunks(start: number, end: number, layout: MoviLayout, depth: number, strict: boolean) {
		if (depth > 16) {
			if (strict) {
				throw new Error('AVI lists are nested too deeply.');
			}
			layout.unknown.push({ start, end });
			return;
		}
		let pos = start;
		let window: FileSlice | null = null;
		while (pos + 8 <= end) {
			if (!window || pos < window.start || pos + 8 > window.end) {
				let slice = this.context.reader.requestSliceRange(pos, 8, Math.min(READ_WINDOW, end - pos));
				if (slice instanceof Promise) {
					slice = await slice;
				}
				window = slice;
			}
			if (!window) {
				if (strict) {
					throw new Error('AVI packet header extends past the end of the file.');
				}
				break;
			}
			window.filePos = pos;
			const id = readAscii(window, 4);
			const size = readU32Le(window);
			if (pos + 8 + size > end) {
				if (strict) {
					throw new Error('AVI packet extends past its containing list.');
				}
				break;
			}
			if (id === 'LIST' && size >= 4) {
				await this.readMoviChunks(pos + 12, pos + 8 + size, layout, depth + 1, strict);
			} else {
				layout.chunks.push({ pos: pos + 8, id, size });
			}
			pos += 8 + size + (size & 1);
		}
		if (pos < end) {
			// Past a malformed chunk we can't tell where the next one starts, only where the list ends
			layout.unknown.push({ start: pos, end });
		}
	}

	private async readMoviLayout(strict: boolean) {
		const layout: MoviLayout = { chunks: [], unknown: [] };
		for (const range of this.moviRanges) {
			await this.readMoviChunks(range.start, range.end, layout, 0, strict);
		}
		return layout;
	}

	private async validPacket(pos: number, size: number, id: string) {
		if (!this.moviLayout) {
			this.moviLayout = await this.readMoviLayout(false);
		}
		// Chunks are in file order, so the last one starting at or before this position is the one containing it
		const chunk = this.moviLayout.chunks[lastIndexAtOrBefore(this.moviLayout.chunks, chunk => chunk.pos, pos)];
		if (chunk?.pos === pos) {
			return chunk.id === id && chunk.size === size;
		}
		// The walk saw no chunk header here, so let's check the header in place. Both header and packet must lie
		// within whatever the walk found around them: a chunk's payload, or the unwalked rest of a list
		const unknown = this.moviLayout.unknown;
		const tail = unknown[lastIndexAtOrBefore(unknown, range => range.start, pos - 8)];
		const end = chunk && pos - 8 >= chunk.pos && pos - 8 < chunk.pos + chunk.size
			? chunk.pos + chunk.size
			: tail && pos - 8 < tail.end ? tail.end : -1;
		if (pos + size > end) {
			return false;
		}
		const header = await this.context.reader.requestSlice(pos - 8, 8);
		return !!header && readAscii(header, 4) === id && readU32Le(header) === size;
	}

	private async readOldIndex(pos: number, size: number, base: number) {
		// A trailing partial entry is less than one entry of garbage, and the loop below reads only whole ones.
		// Entries we accept are checked against the movi layout, so a ragged size on its own says nothing about
		// the entries themselves. It is not proof the index is sound: an entry whose id matches no stream is
		// dropped silently, and the length cross-check that catches that relies on the stream header's count
		let offsetBase: number | null = null;
		let window: FileSlice | null = null;
		for (let offset = 0; offset + 16 <= size; offset += 16) {
			const entryPos = pos + offset;
			if (!window || entryPos + 16 > window.end) {
				window = await this.context.reader.requestSliceRange(
					entryPos, 16, Math.min(READ_WINDOW, size - offset),
				);
			}
			if (!window) {
				this.indexValid = false;
				break;
			}
			window.filePos = entryPos;
			const id = readAscii(window, 4);
			const flags = readU32Le(window);
			const chunkOffset = readU32Le(window);
			const length = readU32Le(window);
			const stream = this.streamForChunk(id);
			if (!stream || this.openDmlStreams.has(stream) || (flags & 0x1)) {
				continue;
			}
			if (offsetBase === null) {
				for (const candidate of [base, 0, base + 4]) {
					if (await this.validPacket(candidate + chunkOffset + 8, length, id)) {
						offsetBase = candidate;
						break;
					}
				}
			}
			const packetPos = (offsetBase ?? 0) + chunkOffset + 8;
			if (offsetBase === null || !await this.validPacket(packetPos, length, id)) {
				this.indexValid = false;
				continue;
			}
			stream.packets.push({ pos: packetPos, size: length, key: !!(flags & 0x10), timestamp: 0, duration: 0 });
		}
	}

	// https://github.com/MicrosoftDocs/sdk-api/blob/docs/sdk-api-src/content/aviriff/ns-aviriff-avistdindex.md
	private async readIndex(stream: AviStream, pos: number, size: number, visited: Set<number>) {
		if (visited.has(pos) || size < 24) {
			this.indexValid = false;
			return;
		}
		visited.add(pos);
		const header = await this.context.reader.requestSlice(pos, 24);
		if (!header) {
			this.indexValid = false;
			return;
		}
		const longs = readU16(header, true);
		const subtype = readBytes(header, 1)[0]!;
		const type = readBytes(header, 1)[0]!;
		if (type === 2) {
			// Timed indexes are rare enough that scanning the movi lists instead is fine
			this.indexValid = false;
			return;
		}
		const count = readU32Le(header);
		const id = readAscii(header, 4);
		if (this.streamForChunk(id) !== stream || count * longs * 4 > size - 24) {
			this.indexValid = false;
			return;
		}
		if (type === 0 && longs === 4 && (subtype === 0 || subtype === 1)) {
			let window: FileSlice | null = null;
			for (let i = 0; i < count; i++) {
				const entryPos = pos + 24 + 16 * i;
				if (!window || entryPos + 16 > window.end) {
					window = await this.context.reader.requestSliceRange(
						entryPos, 16, Math.min(READ_WINDOW, 16 * (count - i)),
					);
				}
				if (!window) {
					this.indexValid = false;
					break;
				}
				window.filePos = entryPos;
				const entry = window;
				const offset = readU64(entry, true);
				const length = readU32Le(entry);
				if (!Number.isSafeInteger(offset) || length < 32 || visited.size > 100000) {
					this.indexValid = false;
					continue;
				}
				const leaf = await this.context.reader.requestSlice(offset, 8);
				if (!leaf || !/^ix\d{2}$/.test(readAscii(leaf, 4)) || readU32Le(leaf) + 8 !== length) {
					this.indexValid = false;
					continue;
				}
				await this.readIndex(stream, offset + 8, length - 8, visited);
			}
		} else if (type === 1 && ((longs === 2 && subtype === 0) || (longs === 3 && subtype === 1))) {
			const base = readU64(header, true);
			for (let i = 0; i < count; i++) {
				const entry = await this.context.reader.requestSlice(pos + 24 + longs * 4 * i, longs * 4);
				if (!entry) {
					this.indexValid = false;
					break;
				}
				const offset = readU32Le(entry);
				const flags = readU32Le(entry);
				const length = flags & 0x7fffffff;
				// OpenDML offsets address the payload; the high size bit marks delta frames
				if (!await this.validPacket(base + offset, length, id)) {
					this.indexValid = false;
					continue;
				}
				stream.packets.push({
					pos: base + offset, size: length, key: !(flags & 0x80000000), timestamp: 0, duration: 0,
				});
			}
		} else {
			this.indexValid = false;
		}
	}

	private commonTrack(stream: AviStream, id: number): BaseCustomTrack {
		const packets = stream.packets;
		const findPacket = (timestamp: number, key: boolean) => {
			let index = lastIndexAtOrBefore(packets, packet => packet.timestamp, timestamp);
			while (key && index >= 0 && !packets[index]!.key) {
				index--;
			}
			return index;
		};
		const getPacket = async (index: number, options: PacketRetrievalOptions) => {
			if (this.context.signal.aborted) {
				throw new InputDisposedError();
			}
			const packet = packets[index];
			if (!packet) {
				return null;
			}
			const type = packet.key || stream.type === 'auds' ? 'key' : 'delta';
			if (options.metadataOnly) {
				return EncodedPacket.metadataOnly(type, packet.timestamp, packet.duration, index, packet.size);
			}
			const data = await this.readPacketBytes(packet);
			return new EncodedPacket(data, type, packet.timestamp, packet.duration, index);
		};
		return {
			id, timeResolution: stream.rate / stream.scale, name: stream.name,
			getDurationFromMetadata: () => {
				const last = packets[packets.length - 1];
				return last ? last.timestamp + last.duration : 0;
			},
			getFirstPacket: options => getPacket(0, options),
			getNextPacket: (packet, options) => getPacket(packet.sequenceNumber + 1, options),
			getPacket: (timestamp, options) => getPacket(findPacket(timestamp, false), options),
			getKeyPacket: (timestamp, options) => getPacket(findPacket(timestamp, stream.type !== 'auds'), options),
			getNextKeyPacket: (packet, options) => {
				let index = packet.sequenceNumber + 1;
				while (index < packets.length && stream.type !== 'auds' && !packets[index]!.key) {
					index++;
				}
				return getPacket(index, options);
			},
		};
	}

	private async readPacketBytes(packet: AviPacket) {
		const segments = packet.segments ?? [{ pos: packet.pos, size: packet.size }];
		const data = segments.length === 1 ? null : new Uint8Array(packet.size);
		let offset = 0;
		for (const segment of segments) {
			let slice = this.context.reader.requestSlice(segment.pos, segment.size);
			if (slice instanceof Promise) {
				slice = await slice;
			}
			if (!slice) {
				throw new Error('AVI packet extends past the end of the file.');
			}
			const bytes = readBytes(slice, slice.length);
			if (!data) {
				return bytes;
			}
			data.set(bytes, offset);
			offset += bytes.length;
		}
		return data!;
	}

	private async readAudioPackets(
		stream: AviStream,
		codec: AudioCodec,
		sampleRate: number,
		blockAlign: number,
	) {
		const chunks = stream.packets;
		let totalSize = chunks.reduce((sum, packet) => sum + packet.size, 0);
		if (codec !== 'mp3') {
			// A partial sample frame at the end is dropped, as Mediabunny's own WAVE reader does
			totalSize -= totalSize % blockAlign;
		}
		let chunkIndex = 0;
		let chunkOffset = 0;
		const take = (size: number) => {
			const segments: { pos: number; size: number }[] = [];
			while (size > 0 && chunkIndex < chunks.length) {
				const chunk = chunks[chunkIndex]!;
				const length = Math.min(size, chunk.size - chunkOffset);
				if (length > 0) {
					segments.push({ pos: chunk.pos + chunkOffset, size: length });
				}
				size -= length;
				chunkOffset += length;
				if (chunkOffset === chunk.size) {
					chunkIndex++;
					chunkOffset = 0;
				}
			}
			return segments;
		};
		// The frame headers are four bytes every few hundred, so we read them out of a window rather than one
		// read at a time. The stream is walked forwards only, so the window only ever moves forwards
		let window: Uint8Array | null = null;
		let windowAt = 0;
		const headerAt = async (at: number) => {
			if (!window || at < windowAt || at + 4 > windowAt + window.length) {
				const savedIndex = chunkIndex;
				const savedOffset = chunkOffset;
				const segments = take(Math.min(READ_WINDOW, totalSize - at));
				chunkIndex = savedIndex;
				chunkOffset = savedOffset;
				const length = segments.reduce((sum, segment) => sum + segment.size, 0);
				window = await this.readPacketBytes({
					pos: 0, size: length, segments, key: true, timestamp: 0, duration: 0,
				});
				windowAt = at;
			}
			return window.subarray(at - windowAt, at - windowAt + 4);
		};
		const packets: AviPacket[] = [];
		let offset = 0;
		let samples = 0;
		let reference: Mp3Frame | null = null;
		while (offset < totalSize) {
			let size: number;
			let count: number;
			if (codec === 'mp3') {
				// AVI chunks may contain several audio frames, or only part of one
				const frame = readMp3Frame(await headerAt(offset));
				// Frames are matched against the first one we found rather than against the stream header, which
				// recovers streams whose header lies, and junk between them is stepped over a byte at a time
				if (!frame || (reference && !sameMp3Configuration(frame, reference))) {
					take(1);
					offset++;
					continue;
				}
				reference ??= frame;
				size = frame.size;
				count = frame.count;
			} else {
				size = Math.min(totalSize - offset, 2048 * blockAlign);
				count = size / blockAlign;
			}
			if (offset + size > totalSize) {
				// The stream ends inside this frame, so there is no whole frame left to hand over
				break;
			}
			const segments = take(size);
			packets.push({
				pos: segments[0]!.pos, size, segments: segments.length === 1 ? undefined : segments, key: true,
				timestamp: stream.start * stream.scale / stream.rate + samples / sampleRate,
				duration: count / sampleRate,
			});
			samples += count;
			offset += size;
		}
		stream.packets = packets;
	}

	private async createVideoTrack(stream: AviStream, id: number): Promise<CustomVideoTrack | null> {
		const format = stream.format!;
		if (format.length < 40) {
			throw new Error('Invalid AVI video format');
		}
		const headerSize = readU32Le(format);
		const width = readI32Le(format);
		const height = readI32Le(format);
		format.skip(4); // Planes and bit depth
		const fourCc = readAscii(format, 4);
		// Writers spell these in either case, so the table is keyed in upper case and the identifier folded to it
		const codecs: Record<string, VideoCodec> = {
			H264: 'avc', X264: 'avc', AVC1: 'avc',
			APCH: 'prores', APCN: 'prores', APCS: 'prores', APCO: 'prores', AP4H: 'prores', AP4X: 'prores',
			FMP4: 'mpeg4', XVID: 'mpeg4', DIVX: 'mpeg4', DX50: 'mpeg4', MP4V: 'mpeg4',
		};
		const name = codecs[fourCc.toUpperCase()];
		const codec = name ?? null;
		if (codec === 'prores') {
			for (const packet of stream.packets) {
				packet.key = true;
			}
		}
		if (width <= 0 || height === 0 || headerSize < 40 || headerSize > format.length) {
			throw new Error('Invalid AVI video dimensions or header size');
		}
		const extra = format.slice(format.start + headerSize);
		// A copy, not a view: this outlives the call, captured by getDecoderConfig for the track's lifetime
		const description = new Uint8Array(readBytes(extra, extra.length));
		if (codec === 'avc' || codec === 'mpeg4') {
			for (const packet of stream.packets) {
				const data = await this.readPacketBytes(packet);
				const key = inspectVideoPacket(data, codec === 'avc' ? 'avc' : 'mpeg4', description);
				if (key === null) {
					// Timing and keyframes would both be guesses, so we cannot describe this track honestly
					return null;
				}
				packet.key = key;
				if (codec === 'avc' && packet.key && description.length > 0 && description[0] !== 1) {
					// For Annex B, we need the parameter sets in the key packets
					packet.segments = [
						{ pos: extra.start, size: description.length },
						{ pos: packet.pos, size: packet.size },
					];
					packet.size += description.length;
				}
			}
		}
		return {
			...this.commonTrack(stream, id), type: 'video', codec, internalCodecId: fourCc,
			// AVISF_DISABLED marks a stream a player should not pick by default, not one to hide
			disposition: { default: !(stream.flags & 1) },
			codedWidth: width, codedHeight: Math.abs(height),
			getDecoderConfig: async () => {
				if (!codec) {
					return null;
				}
				if (codec === 'mpeg4') {
					return { codec, codedWidth: width, codedHeight: Math.abs(height), description };
				}
				if (codec === 'prores') {
					return { codec: fourCc.toLowerCase(), codedWidth: width, codedHeight: Math.abs(height) };
				}
				let config: Uint8Array<ArrayBufferLike> = description;
				if (config[0] === 1 && config.length >= 4) {
					const profile = [...config.subarray(1, 4)].map(x => x.toString(16).padStart(2, '0')).join('');
					return { codec: `avc1.${profile}`, codedWidth: width, codedHeight: Math.abs(height), description };
				}
				if (!config.length && stream.packets[0]) {
					const first = stream.packets[0];
					const slice = await this.context.reader.requestSlice(first.pos, first.size);
					config = slice ? readBytes(slice, slice.length) : new Uint8Array(0);
				}
				for (let i = 0; i + 7 <= config.length; i++) {
					if (config[i] === 0 && config[i + 1] === 0 && config[i + 2] === 1 && (config[i + 3]! & 31) === 7) {
						const profile = [...config.subarray(i + 4, i + 7)]
							.map(x => x.toString(16).padStart(2, '0')).join('');
						return { codec: `avc1.${profile}`, codedWidth: width, codedHeight: Math.abs(height) };
					}
				}
				return null;
			},
		};
	}

	private async createAudioTrack(stream: AviStream, id: number): Promise<CustomAudioTrack> {
		const format = stream.format!;
		if (format.length < 14) {
			throw new Error('Invalid AVI audio format');
		}
		let tag = readU16(format, true);
		const channels = readU16(format, true);
		const sampleRate = readU32Le(format);
		format.skip(4); // Average bytes per second
		const blockAlign = readU16(format, true);
		const bits = format.length >= 16 ? readU16(format, true) : 8;
		const extraSize = format.length >= 18 ? readU16(format, true) : 0;
		if (extraSize > format.remainingLength || !channels || !sampleRate || !blockAlign) {
			throw new Error('Invalid AVI audio configuration');
		}
		const extra = readBytes(format, extraSize);
		const originalTag = tag;
		if (tag === 0xfffe) {
			const suffix = [0, 0, 0, 0, 16, 0, 128, 0, 0, 170, 0, 56, 155, 113];
			if (extra.length < 22 || !suffix.every((value, i) => extra[i + 8] === value)) {
				tag = -1;
			} else {
				const view = new DataView(extra.buffer, extra.byteOffset, extra.byteLength);
				if (view.getUint16(0, true) > bits) {
					throw new Error('Invalid AVI valid bit count');
				}
				tag = view.getUint16(6, true);
			}
		}
		let codec: AudioCodec | null = null;
		if (tag === 1) {
			const codecs: Record<number, AudioCodec> = { 8: 'pcm-u8', 16: 'pcm-s16', 24: 'pcm-s24', 32: 'pcm-s32' };
			codec = codecs[bits] ?? null;
		} else if (tag === 3) {
			codec = bits === 32 ? 'pcm-f32' : bits === 64 ? 'pcm-f64' : null;
		} else {
			const codecs: Record<number, AudioCodec> = { 6: 'alaw', 7: 'ulaw', 0x55: 'mp3' };
			codec = codecs[tag] ?? null;
		}
		if (codec && (PCM_AUDIO_CODECS as readonly string[]).includes(codec)) {
			const bytesPerSample = codec === 'alaw' || codec === 'ulaw' ? 1 : bits / 8;
			if (blockAlign !== channels * bytesPerSample) {
				throw new Error('AVI audio block alignment does not match its sample format.');
			}
		}
		if (codec === 'mp3' || (codec && (PCM_AUDIO_CODECS as readonly string[]).includes(codec))) {
			await this.readAudioPackets(stream, codec, sampleRate, blockAlign);
		}
		// The stream's time base may count bytes, but we need sample-accurate timing
		let a = stream.rate;
		let b = sampleRate;
		while (b !== 0) {
			[a, b] = [b, a % b];
		}
		const timeResolution = stream.rate / a * sampleRate;
		if (!Number.isSafeInteger(timeResolution)) {
			throw new Error('AVI audio time resolution is too large.');
		}

		return {
			...this.commonTrack(stream, id), timeResolution, type: 'audio', codec, internalCodecId: originalTag,
			disposition: { default: !(stream.flags & 1) },
			numberOfChannels: channels, sampleRate, hasOnlyKeyPackets: true,
			getDecoderConfig: () => codec
				? {
						codec,
						numberOfChannels: channels, sampleRate,
					}
				: null,
		};
	}
}

type Mp3Frame = { version: number; rate: number; channels: number; size: number; count: number };

const MP3_SAMPLE_RATES = [44100, 48000, 32000];
const MP3_BIT_RATES = {
	1: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
	2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
};

/** Reads a Layer III frame header, or returns null when these bytes do not begin one. */
const readMp3Frame = (header: Uint8Array): Mp3Frame | null => {
	if (header.length < 4 || header[0] !== 255 || (header[1]! & 224) !== 224) {
		return null;
	}
	const version = (header[1]! >> 3) & 3;
	const layer = (header[1]! >> 1) & 3;
	const rateIndex = (header[2]! >> 2) & 3;
	const bitRateIndex = header[2]! >> 4;
	if (version === 1 || layer !== 1 || rateIndex === 3 || bitRateIndex === 0 || bitRateIndex === 15) {
		return null;
	}
	const rate = MP3_SAMPLE_RATES[rateIndex]! / (version === 3 ? 1 : version === 2 ? 2 : 4);
	return {
		version,
		rate,
		channels: (header[3]! >> 6) === 3 ? 1 : 2,
		size: Math.floor((version === 3 ? 144 : 72) * MP3_BIT_RATES[version === 3 ? 1 : 2][bitRateIndex]! * 1000
			/ rate) + ((header[2]! >> 1) & 1),
		count: version === 3 ? 1152 : 576,
	};
};

const sameMp3Configuration = (frame: Mp3Frame, reference: Mp3Frame) => frame.version === reference.version
	&& frame.rate === reference.rate && frame.channels === reference.channels;

const inspectVideoPacket = (data: Uint8Array, codec: 'avc' | 'mpeg4', description: Uint8Array) => {
	const units: Uint8Array[] = [];
	if (codec === 'avc' && description[0] === 1 && description.length >= 5) {
		const lengthSize = (description[4]! & 3) + 1;
		for (let pos = 0; pos + lengthSize <= data.length;) {
			let size = 0;
			for (let i = 0; i < lengthSize; i++) {
				size = size * 256 + data[pos++]!;
			}
			// A zero-length or overrunning unit is left to the decoder, as Mediabunny's own walker leaves it
			units.push(data.subarray(pos, pos + size));
			pos += size;
		}
	} else {
		let start = -1;
		// Hop to each candidate final byte of a start code rather than reading every byte in turn
		for (let i = data.indexOf(1, 2); i !== -1; i = data.indexOf(1, i + 1)) {
			if (data[i - 1] !== 0 || data[i - 2] !== 0) {
				continue;
			}
			// A four-byte start code leaves its leading zero at the end of the previous unit
			const end = data[i - 3] === 0 ? i - 3 : i - 2;
			if (start !== -1 && end > start) {
				units.push(data.subarray(start, end));
			}
			start = i + 1;
		}
		if (start !== -1 && start < data.length) {
			units.push(data.subarray(start));
		}
	}
	let key = false;
	let slices = 0;
	let intraSlices = 0;
	for (const unit of units) {
		if (codec === 'mpeg4') {
			if (unit[0] === 0xb6 && unit.length > 1) {
				const type = unit[1]! >> 6;
				if (type === 2) {
					return null;
				}
				key ||= type === 0;
			}
			continue;
		}
		const type = unit[0]! & 31;
		if (type === 2 || type === 3 || type === 4 || type === 19 || type === 20 || type === 21) {
			return null;
		}
		if (type !== 1 && type !== 5) {
			continue;
		}
		key ||= type === 5;
		const bytes: number[] = [];
		for (let i = 1; i < Math.min(unit.length, 32); i++) {
			if (i >= 3 && unit[i] === 3 && unit[i - 1] === 0 && unit[i - 2] === 0) {
				continue;
			}
			bytes.push(unit[i]!);
		}
		let bit = 0;
		const readBit = () => {
			if (bit >= bytes.length * 8) {
				throw new Error('Invalid AVC slice header in AVI');
			}
			return (bytes[bit >> 3]! >> (7 - (bit++ & 7))) & 1;
		};
		const readUnsigned = () => {
			let zeros = 0;
			while (!readBit()) {
				if (++zeros > 24) {
					throw new Error('Invalid AVC slice header in AVI');
				}
			}
			let value = 1;
			for (let i = 0; i < zeros; i++) {
				value = 2 * value + readBit();
			}
			return value - 1;
		};
		let sliceType: number;
		try {
			readUnsigned(); // First macroblock in the slice
			sliceType = readUnsigned() % 5;
		} catch {
			// Without the slice header we cannot tell a B-frame from a keyframe
			return null;
		}
		if (sliceType === 1) {
			return null;
		}
		slices++;
		if (sliceType === 2) {
			intraSlices++;
		}
	}
	// Open-GOP encoders signal a keyframe with intra slices in a non-IDR unit, so a picture whose every slice is
	// intra-coded is one as well
	return key || (slices > 0 && slices === intraSlices);
};
