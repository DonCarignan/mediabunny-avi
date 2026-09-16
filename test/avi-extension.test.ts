import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import {
	BufferSource,
	BufferTarget,
	Conversion,
	CustomSource,
	CustomVideoDecoder,
	type EncodedPacket,
	getAllVideoCodecs,
	Input,
	Mp4OutputFormat,
	Output,
	PacketCursor,
	registerDecoder,
	type VideoCodec,
} from 'mediabunny';
import { AVI } from 'mediabunny-avi';

function assert(x: unknown): asserts x {
	if (!x) {
		throw new Error('Assertion failed.');
	}
}

// One audio or video stream with the given number of samples or frames
const makeHdrl = (options: {
	format?: Uint8Array;
	video?: boolean;
	length: number;
	mustUseIndex?: boolean;
	disabled?: boolean;
}) => {
	const format = options.format ?? concat(u16(1), u16(2), u32(8000), u32(32000), u16(4), u16(16));
	const header = new Uint8Array(56);
	if (options.mustUseIndex) {
		header[12] = 0x20;
	}
	const stream = new Uint8Array(56);
	stream.set(ascii(options.video ? 'vids' : 'auds'));
	const view = new DataView(stream.buffer);
	if (options.disabled) {
		view.setUint32(8, 1, true); // AVISF_DISABLED
	}
	view.setUint32(20, 1, true);
	view.setUint32(24, options.video ? 25 : 8000, true);
	view.setUint32(32, options.length, true);
	view.setUint32(44, options.video ? 0 : 4, true);
	return list('hdrl', chunk('avih', header), list('strl', chunk('strh', stream), chunk('strf', format)));
};

const makeAvi = (packets: Uint8Array[], options: {
	format?: Uint8Array;
	video?: boolean;
	index?: boolean;
	absolute?: boolean;
	repeat?: boolean;
	mustUseIndex?: boolean;
	disabled?: boolean;
	entryFlags?: number;
	zeroLength?: boolean;
} = {}) => {
	const length = options.video
		? packets.length
		: packets.reduce((sum, p) => sum + p.length, 0) / 4;
	const hdrl = makeHdrl({ ...options, length: options.zeroLength ? 0 : length * (options.repeat ? 2 : 1) });
	const movi = list('movi', ...packets.map(packet => chunk(options.video ? '00dc' : '00wb', packet)));
	const base = 12 + hdrl.length + 8;
	const entries: Uint8Array[] = [];
	let pos = 4;
	for (const packet of packets) {
		entries.push(concat(
			ascii(options.video ? '00dc' : '00wb'), u32(options.entryFlags ?? 16),
			u32(pos + (options.absolute ? base : 0)), u32(packet.length),
		));
		pos += 8 + packet.length + (packet.length & 1);
	}
	const index = options.index ? chunk('idx1', concat(...entries)) : new Uint8Array(0);
	const content = concat(ascii('AVI '), hdrl, movi, index, ...(options.repeat ? [index] : []));
	return chunk('RIFF', content);
};

const concat = (...parts: Uint8Array[]) => {
	const result = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
	let pos = 0;
	for (const part of parts) {
		result.set(part, pos);
		pos += part.length;
	}
	return result;
};

const ascii = (value: string) => new TextEncoder().encode(value);

const u16 = (value: number) => {
	const bytes = new Uint8Array(2);
	new DataView(bytes.buffer).setUint16(0, value, true);
	return bytes;
};

const u32be = (value: number) => {
	const bytes = new Uint8Array(4);
	new DataView(bytes.buffer).setUint32(0, value, false);
	return bytes;
};

const u32 = (value: number) => {
	const bytes = new Uint8Array(4);
	new DataView(bytes.buffer).setUint32(0, value, true);
	return bytes;
};

const chunk = (id: string, data: Uint8Array) => concat(
	ascii(id), u32(data.length), data, new Uint8Array(data.length & 1),
);

const list = (id: string, ...parts: Uint8Array[]) => chunk('LIST', concat(ascii(id), ...parts));

test('PCM chunk boundaries', async () => {
	const bytes = makeAvi([new Uint8Array([1]), new Uint8Array([2, 3, 4])]);
	using input = new Input({ source: new BufferSource(bytes), formats: [AVI] });
	const tracks = await input.getAudioTracks();
	expect(tracks).toHaveLength(1);
	const cursor = new PacketCursor(tracks[0]!);
	const packet = await cursor.next();
	expect(packet?.data).toEqual(new Uint8Array([1, 2, 3, 4]));
	expect(packet?.duration).toBe(1 / 8000);
	expect(await cursor.next()).toBeNull();
});

test('PCM legacy indexes', async () => {
	for (const absolute of [false, true]) {
		const bytes = makeAvi([new Uint8Array([1, 2, 3, 4])], { index: true, absolute, repeat: true });
		using input = new Input({ source: new BufferSource(bytes), formats: [AVI] });
		const track = await input.getPrimaryAudioTrack();
		assert(track);
		const cursor = new PacketCursor(track);
		expect((await cursor.next())?.data).toEqual(new Uint8Array([1, 2, 3, 4, 1, 2, 3, 4]));
		expect(await track.computeDuration()).toBe(2 / 8000);
	}
});

test('Extensible PCM bit depth', async () => {
	const format = concat(
		u16(0xfffe), u16(2), u32(8000), u32(64000), u16(8), u16(32), u16(22),
		u16(24), u32(3), new Uint8Array([1, 0, 0, 0, 0, 0, 16, 0, 128, 0, 0, 170, 0, 56, 155, 113]),
	);
	using input = new Input({ source: new BufferSource(makeAvi([new Uint8Array(8)], { format })), formats: [AVI] });
	const track = await input.getPrimaryAudioTrack();
	expect(await track?.getCodec()).toBe('pcm-s32');
	expect(await track?.computeDuration()).toBe(1 / 8000);
});

test('MP3 chunk boundaries', async () => {
	const frame = new Uint8Array(417);
	frame.set([255, 251, 144, 0]);
	const data = concat(frame, frame);
	const format = concat(u16(0x55), u16(2), u32(44100), u32(16000), u16(1), u16(0), u16(0));
	for (const chunks of [[data], [data.subarray(0, 2), data.subarray(2, 418), data.subarray(418)]]) {
		using input = new Input({ source: new BufferSource(makeAvi(chunks, { format })), formats: [AVI] });
		const track = await input.getPrimaryAudioTrack();
		assert(track);
		const cursor = new PacketCursor(track);
		expect((await cursor.next())?.data).toEqual(frame);
		const second = await cursor.next();
		expect(second?.data).toEqual(frame);
		expect(second?.timestamp).toBe(1152 / 44100);
		expect(await cursor.next()).toBeNull();
		expect(await track.computeDuration()).toBe(2304 / 44100);
	}
});

test('Real files, AVC with PCM and MPEG-4 Part 2 with MP3', async () => {
	const avcBytes = readFileSync(new URL('./fixtures/avc-pcm.avi', import.meta.url));
	using avcInput = new Input({ source: new BufferSource(avcBytes), formats: [AVI] });
	let video = await avcInput.getPrimaryVideoTrack();
	let audio = await avcInput.getPrimaryAudioTrack();
	assert(video && audio);
	expect(await video.getCodec()).toBe('avc');
	expect([await video.getCodedWidth(), await video.getCodedHeight()]).toEqual([64, 64]);
	expect(await audio.getCodec()).toBe('pcm-s16');
	expect(await audio.getSampleRate()).toBe(8000);
	expect(await audio.computeDuration()).toBe(1);
	let types: string[] = [];
	for await (const packet of new PacketCursor(video)) {
		types.push(packet.type);
	}
	// A keyframe every five frames, as the file was encoded
	expect(types).toHaveLength(25);
	expect(types.map((_, i) => (i % 5 === 0 ? 'key' : 'delta'))).toEqual(types);

	// The typical AVI codecs; the demuxer inspects MPEG-4 packets itself, nothing needs to be registered
	const mpeg4Bytes = readFileSync(new URL('./fixtures/mpeg4-mp3.avi', import.meta.url));
	using mpeg4Input = new Input({ source: new BufferSource(mpeg4Bytes), formats: [AVI] });
	video = await mpeg4Input.getPrimaryVideoTrack();
	audio = await mpeg4Input.getPrimaryAudioTrack();
	assert(video && audio);
	expect(await video.getCodec()).toBe('mpeg4');
	expect(await video.computeDuration()).toBeCloseTo(27 / 25);
	expect(await audio.getCodec()).toBe('mp3');
	expect(await audio.getSampleRate()).toBe(16000);
	expect(await audio.getNumberOfChannels()).toBe(1);
	types = [];
	for await (const packet of new PacketCursor(video)) {
		types.push(packet.type);
	}
	expect(types).toHaveLength(25);
	expect(types.map((_, i) => (i % 5 === 0 ? 'key' : 'delta'))).toEqual(types);
});

test('OpenDML, two RIFF segments', async () => {
	const bytes = readFileSync(new URL('./fixtures/opendml.avi', import.meta.url));
	const timedBytes = new Uint8Array(bytes);
	const indexPos = bytes.indexOf('indx');
	expect(indexPos).toBeGreaterThan(0);
	timedBytes[indexPos + 11] = 2;
	// A timed index can't be used, so the packets come from scanning the movi lists instead
	for (const source of [bytes, timedBytes]) {
		using input = new Input({ source: new BufferSource(source), formats: [AVI] });
		const tracks = await input.getAudioTracks();
		expect(tracks).toHaveLength(2);
		const sizes: number[] = [];
		for (const track of tracks) {
			const cursor = new PacketCursor(track, { metadataOnly: true });
			let size = 0;
			let packet: EncodedPacket | null;
			while ((packet = await cursor.next())) {
				expect(packet.isMetadataOnly).toBe(true);
				size += packet.byteLength;
			}
			sizes.push(size);
		}
		expect(sizes).toEqual([732, 232]);
	}
	// With AVIF_MUSTUSEINDEX set, there's no fallback, so the error must name the unusable index
	const strictBytes = new Uint8Array(timedBytes);
	const flagsPos = bytes.indexOf('avih') + 20;
	strictBytes[flagsPos] = strictBytes[flagsPos]! | 0x20;
	using strict = new Input({ source: new BufferSource(strictBytes), formats: [AVI] });
	await expect(strict.getTracks()).rejects.toThrow('unsupported');
});

test('AVI trailing padding', async () => {
	const frame = new Uint8Array([1, 2, 3, 4]);
	const bytes = makeAvi([frame]);
	for (const tail of [new Uint8Array(24), ascii('trailing file data'), chunk('JUNK', new Uint8Array(17))]) {
		using input = new Input({ source: new BufferSource(concat(bytes, tail)), formats: [AVI] });
		const track = await input.getPrimaryAudioTrack();
		assert(track);
		const cursor = new PacketCursor(track);
		expect((await cursor.next())?.data).toEqual(frame);
		expect(await cursor.next()).toBeNull();
	}

	const extra = chunk('RIFF', concat(ascii('AVIX'), list('movi', chunk('00wb', frame))));
	using input = new Input({
		source: new BufferSource(concat(bytes, chunk('JUNK', new Uint8Array(17)), extra)), formats: [AVI],
	});
	const track = await input.getPrimaryAudioTrack();
	assert(track);
	const cursor = new PacketCursor(track);
	expect((await cursor.next())?.data).toEqual(concat(frame, frame));
	expect(await cursor.next()).toBeNull();
	expect(await track.computeDuration()).toBe(2 / 8000);

	using invalid = new Input({
		source: new BufferSource(concat(bytes, chunk('RIFF', ascii('WAVE')))), formats: [AVI],
	});
	await expect(invalid.getTracks()).rejects.toThrow('wrong RIFF header');
});

test('Invalid AVI chunks', async () => {
	const bytes = makeAvi([new Uint8Array(4)]);
	const strf = Buffer.from(bytes).indexOf('strf');
	new DataView(bytes.buffer).setUint32(strf + 4, 0x100000, true);
	using input = new Input({ source: new BufferSource(bytes), formats: [AVI] });
	await expect(input.getTracks()).rejects.toThrow('containing list');

	using other = new Input({ source: new BufferSource(makeAvi([new Uint8Array(3)])), formats: [AVI] });
	const partial = await other.getPrimaryAudioTrack();
	assert(partial);
	expect(await new PacketCursor(partial).next()).toBeNull();

	const format = concat(u16(1), u16(2), u32(8000), u32(32000), u16(1), u16(16));
	using unaligned = new Input({
		source: new BufferSource(makeAvi([new Uint8Array(4)], { format })), formats: [AVI],
	});
	await expect(unaligned.getTracks()).rejects.toThrow('block alignment');

	const complete = makeAvi([new Uint8Array(4)]);
	using truncated = new Input({ source: new BufferSource(complete.subarray(0, -1)), formats: [AVI] });
	await expect(truncated.getTracks()).rejects.toThrow('containing list');
});

test('Streams we cannot expose skip the movi walk', async () => {
	// DV Type-1 interleaves its audio into the video stream, so its only stream is 'iavs' and we expose no track
	const header = new Uint8Array(56);
	header.set(ascii('iavs'));
	const view = new DataView(header.buffer);
	view.setUint32(20, 1, true);
	view.setUint32(24, 25, true);
	view.setUint32(32, 1, true);
	const hdrl = list(
		'hdrl', chunk('avih', new Uint8Array(56)),
		list('strl', chunk('strh', header), chunk('strf', new Uint8Array(40))),
	);
	// Mediabunny reads across a gap of up to 128 KiB rather than seeking, so the packets must be larger than that
	// for a read of the index that follows them to be distinguishable from a walk over them
	const movi = list('movi', chunk('00dc', new Uint8Array(200000)));
	const entries = concat(ascii('00dc'), u32(16), u32(4), u32(200000));
	const bytes = chunk('RIFF', concat(ascii('AVI '), hdrl, movi, chunk('idx1', entries)));
	const moviStart = 12 + hdrl.length + 12;
	const moviEnd = 12 + hdrl.length + movi.length;

	// Reading the index or walking the movi lists means reading the packets, which is most of the file
	let packetReads = 0;
	using input = new Input({
		source: new CustomSource({
			getSize: () => bytes.length,
			read: (start, end) => {
				if (start < moviEnd && end > moviStart) {
					packetReads++;
				}
				return bytes.subarray(start, end);
			},
		}),
		formats: [AVI],
	});
	expect(await input.getTracks()).toEqual([]);
	expect(packetReads).toBe(0);
});

test('AVC headers and B-frames', async () => {
	const description = new Uint8Array([0, 0, 0, 1, 0x67, 0x42, 0, 0x1e, 0, 0, 0, 1, 0x68, 0x80]);
	const frame = new Uint8Array([0, 0, 0, 1, 0x65, 0xb8]);
	const format = new Uint8Array(40 + description.length);
	const view = new DataView(format.buffer);
	view.setUint32(0, 40, true);
	view.setInt32(4, 16, true);
	view.setInt32(8, 16, true);
	format.set(ascii('H264'), 16);
	format.set(description, 40);
	using input = new Input({
		source: new BufferSource(makeAvi([frame], { video: true, format })), formats: [AVI],
	});
	const track = await input.getPrimaryVideoTrack();
	assert(track);
	expect(await track.getDecoderConfig()).toEqual({ codec: 'avc1.42001e', codedWidth: 16, codedHeight: 16 });
	const cursor = new PacketCursor(track);
	expect((await cursor.next())?.data).toEqual(concat(description, frame));
	const metadata = new PacketCursor(track, { metadataOnly: true });
	expect((await metadata.next())?.byteLength).toBe(description.length + frame.length);

	for (const [nalType, sliceType] of [[1, 0xa0], [2, 0xa0]] as const) {
		const packet = new Uint8Array([0, 0, 1, nalType, sliceType]);
		using other = new Input({
			source: new BufferSource(makeAvi([packet], { video: true, format })), formats: [AVI],
		});
		expect(await other.getTracks()).toEqual([]);
	}

	// Without extradata the SPS is found in the first packet, even when its profile bytes end the packet
	const bareFormat = format.slice(0, 40);
	const sps = new Uint8Array([0, 0, 1, 0x67, 0x42, 0, 0x1e]);
	using headerless = new Input({
		source: new BufferSource(makeAvi([sps], { video: true, format: bareFormat })), formats: [AVI],
	});
	const headerlessTrack = await headerless.getPrimaryVideoTrack();
	expect(await headerlessTrack!.getDecoderConfig())
		.toEqual({ codec: 'avc1.42001e', codedWidth: 16, codedHeight: 16 });

	// This slice header stops mid-value, and the next unit's bytes must not be read to finish it
	const cut = new Uint8Array([0, 0, 1, 0x65, 0x82, 0, 0, 1, 0x61, 0x9a]);
	using truncated = new Input({
		source: new BufferSource(makeAvi([cut], { video: true, format })), formats: [AVI],
	});
	expect(await truncated.getTracks()).toEqual([]);
});

// Builds a movi from raw children, so a packet can be placed inside a rec list
const makeListedAvi = (
	children: Uint8Array[],
	entries: { pos: number; size: number }[],
	index: 'none' | 'optional' | 'required',
	trailing = 0,
) => {
	const hdrl = makeHdrl({ length: 2, mustUseIndex: index === 'required' });
	const idx1 = index === 'none'
		? new Uint8Array(0)
		: chunk('idx1', concat(
				...entries.map(e => concat(ascii('00wb'), u32(16), u32(e.pos + 4), u32(e.size))),
				new Uint8Array(trailing),
			));
	return chunk('RIFF', concat(ascii('AVI '), hdrl, list('movi', ...children), idx1));
};

test('Indexed packets may not overrun their list', async () => {
	// This body holds four bytes, but its own header claims eight
	const bad = concat(ascii('00wb'), u32(8), new Uint8Array([1, 2, 3, 4]));
	const junk = chunk('JUNK', new Uint8Array(4));
	const rec = list('rec ', bad);
	const prefix = chunk('00wb', new Uint8Array([5, 6, 7, 8]));
	const good = chunk('00wb', new Uint8Array([9, 9, 9, 9]));
	const overrun = concat(ascii('JUNK'), u32(0x7fffffff), new Uint8Array(4));
	const shapes = [
		{ children: [rec, junk], entries: [{ pos: 12, size: 8 }] },
		{ children: [prefix, rec, junk], entries: [{ pos: 0, size: 4 }, { pos: prefix.length + 12, size: 8 }] },
		{ children: [junk, rec, junk], entries: [{ pos: junk.length + 12, size: 8 }] },
		{ children: [list('rec ', rec, junk)], entries: [{ pos: 24, size: 8 }] },
		{ children: [list('rec ', list('rec ', good), bad), junk], entries: [{ pos: 36, size: 8 }] },
		// After a chunk that overruns, only the list end is known, and the index may still not reach past it
		{
			children: [prefix, overrun, bad],
			entries: [{ pos: 0, size: 4 }, { pos: prefix.length + overrun.length, size: 8 }],
		},
	];
	for (const shape of shapes) {
		// An index must not let a packet reach past its list, just like scanning doesn't
		for (const index of ['none', 'optional'] as const) {
			const bytes = makeListedAvi(shape.children, shape.entries, index);
			using input = new Input({ source: new BufferSource(bytes), formats: [AVI] });
			await expect(input.getPrimaryAudioTrack()).rejects.toThrow('extends past its containing list');
		}
	}
	// An entry must also not point into a chunk's own header, even when the overlapping bytes read as a chunk
	const inner = new Uint8Array(1122);
	inner.set([0, 9, 10, 11, 12]);
	const children = [chunk('J00w', inner), good];
	const overlapping = makeListedAvi(children, [{ pos: 1, size: 4 }, { pos: 8 + inner.length, size: 4 }], 'required');
	using input = new Input({ source: new BufferSource(overlapping), formats: [AVI] });
	await expect(input.getPrimaryAudioTrack()).rejects.toThrow('requires an index');
});

test('Indexed recovery past many malformed chunks', async () => {
	const overrun = concat(ascii('JUNK'), u32(0x7fffffff), new Uint8Array(4));
	const children: Uint8Array[] = [];
	const positions: number[] = [];
	let pos = 0;
	for (let i = 0; i < 500; i++) {
		const packet = chunk('00wb', new Uint8Array([i & 255, i >> 8, 0, 0]));
		children.push(list('rec ', overrun, packet));
		positions.push(pos + 12 + overrun.length);
		pos += 12 + overrun.length + packet.length;
	}
	const entries = positions.map(pos => ({ pos, size: 4 }));
	const bytes = makeListedAvi(children, entries, 'required');
	using input = new Input({ source: new BufferSource(bytes), formats: [AVI] });
	const track = await input.getPrimaryAudioTrack();
	assert(track);
	const data: number[] = [];
	for await (const packet of new PacketCursor(track)) {
		data.push(...packet.data);
	}
	expect(data).toEqual(children.flatMap((_, i) => [i & 255, i >> 8, 0, 0]));
});

test('Indexed packets that scanning would misread', async () => {
	const first = chunk('00wb', new Uint8Array([1, 2, 3, 4]));
	const second = chunk('00wb', new Uint8Array([5, 6, 7, 8]));
	const junk = chunk('JUNK', new Uint8Array(4));
	const overrun = concat(ascii('JUNK'), u32(0x7fffffff), new Uint8Array(4));
	// This size is wrong but lands exactly on the list end, hiding the real chunk inside the claimed span
	const spanning = concat(ascii('00wb'), u32(20), new Uint8Array(8), second);
	const shapes = [
		// Interleaving writers wrap packets in rec lists, sometimes nested, with junk between them
		{
			children: [list('rec ', first), junk, list('rec ', list('rec ', second))],
			positions: [12, 12 + first.length + junk.length + 24],
		},
		// Scanning goes wrong at a bad chunk, but a correct index still points at the right packets
		{ children: [first, overrun, second], positions: [0, first.length + overrun.length] },
		{ children: [first, spanning], positions: [0, first.length + 16] },
	];
	for (const shape of shapes) {
		// Writers leave anything from nothing to a truncated entry after the last whole one
		for (const trailing of [0, 1, 15]) {
			// The file requires its index, so a rejected entry would throw here instead of falling back to a scan
			const entries = shape.positions.map(pos => ({ pos, size: 4 }));
			const bytes = makeListedAvi(shape.children, entries, 'required', trailing);
			using input = new Input({ source: new BufferSource(bytes), formats: [AVI] });
			const track = await input.getPrimaryAudioTrack();
			assert(track);
			const cursor = new PacketCursor(track);
			const packets: EncodedPacket[] = [];
			for await (const packet of cursor) {
				packets.push(packet);
			}
			expect(packets.map(packet => [...packet.data])).toEqual([[1, 2, 3, 4, 5, 6, 7, 8]]);
		}
	}
});

test('Indexed video, bitstream overrides the index', async () => {
	const description = new Uint8Array([0, 0, 0, 1, 0x67, 0x42, 0, 0x1e, 0, 0, 0, 1, 0x68, 0x80]);
	const format = new Uint8Array(40 + description.length);
	const view = new DataView(format.buffer);
	view.setUint32(0, 40, true);
	view.setInt32(4, 16, true);
	view.setInt32(8, 16, true);
	format.set(ascii('H264'), 16);
	format.set(description, 40);
	const idr = new Uint8Array([0, 0, 0, 1, 0x65, 0xb8]);
	const inter = new Uint8Array([0, 0, 0, 1, 0x61, 0x9a]);
	// makeAvi's index marks every entry as a keyframe, which real writers do too
	const bytes = makeAvi([idr, inter, inter], { format, video: true, index: true });
	using input = new Input({ source: new BufferSource(bytes), formats: [AVI] });
	const track = await input.getPrimaryVideoTrack();
	assert(track);
	const cursor = new PacketCursor(track);
	const packets: EncodedPacket[] = [];
	for await (const packet of cursor) {
		packets.push(packet);
	}
	expect(packets.map(packet => packet.type)).toEqual(['key', 'delta', 'delta']);
	// Annex B carries its parameter sets in the key packet, so only that one grows
	expect(packets[0]!.data).toEqual(concat(description, idr));
	expect(packets[1]!.data).toEqual(inter);

	const withBFrame = makeAvi([idr, new Uint8Array([0, 0, 1, 1, 0xa0])], { format, video: true, index: true });
	using other = new Input({ source: new BufferSource(withBFrame), formats: [AVI] });
	expect(await other.getTracks()).toEqual([]);
});

test('AVC keyframes signalled as intra slices', async () => {
	const description = new Uint8Array([0, 0, 0, 1, 0x67, 0x42, 0, 0x1e, 0, 0, 0, 1, 0x68, 0x80]);
	const format = new Uint8Array(40 + description.length);
	const view = new DataView(format.buffer);
	view.setUint32(0, 40, true);
	view.setInt32(4, 16, true);
	view.setInt32(8, 16, true);
	format.set(ascii('H264'), 16);
	format.set(description, 40);
	// Open-GOP encoders keep a keyframe out of an IDR unit: 0x61 is a non-IDR unit, 0x88 an intra slice header
	const intra = new Uint8Array([0, 0, 0, 1, 0x61, 0x88]);
	const inter = new Uint8Array([0, 0, 0, 1, 0x61, 0xc0]);
	const bytes = makeAvi([intra, inter, inter], { format, video: true, index: true });
	using input = new Input({ source: new BufferSource(bytes), formats: [AVI] });
	const track = await input.getPrimaryVideoTrack();
	assert(track);
	const cursor = new PacketCursor(track);
	const packets: EncodedPacket[] = [];
	for await (const packet of cursor) {
		packets.push(packet);
	}
	expect(packets.map(packet => packet.type)).toEqual(['key', 'delta', 'delta']);
});

test('Chunk ids in upper case', async () => {
	// Writers differ on the case of the two-cc, and both spellings name the same stream
	for (const id of ['00wb', '00WB']) {
		const hdrl = makeHdrl({ length: 1 });
		const movi = list('movi', chunk(id, new Uint8Array([1, 2, 3, 4])));
		using input = new Input({
			source: new BufferSource(chunk('RIFF', concat(ascii('AVI '), hdrl, movi))),
			formats: [AVI],
		});
		const track = await input.getPrimaryAudioTrack();
		assert(track);
		expect(await track.computeDuration()).toBe(1 / 8000);
	}
});

test('A stream we cannot expose does not invalidate the index', async () => {
	// DV Type-1 carries its audio inside an 'iavs' stream we never expose. An index entry for such a stream must
	// not discard the index that the streams we do expose depend on
	const header = (type: string, rate: number, length: number, sampleSize: number) => {
		const stream = new Uint8Array(56);
		stream.set(ascii(type));
		const view = new DataView(stream.buffer);
		view.setUint32(20, 1, true);
		view.setUint32(24, rate, true);
		view.setUint32(32, length, true);
		view.setUint32(44, sampleSize, true);
		return stream;
	};
	const pcm = concat(u16(1), u16(2), u32(8000), u32(32000), u16(4), u16(16));
	const hdrl = list(
		'hdrl', chunk('avih', new Uint8Array(56)),
		list('strl', chunk('strh', header('auds', 8000, 2, 4)), chunk('strf', pcm)),
		list('strl', chunk('strh', header('iavs', 25, 1, 0)), chunk('strf', new Uint8Array(40))),
	);
	const first = chunk('00wb', new Uint8Array([1, 2, 3, 4]));
	// The tolerant walk cannot get past this, so a discarded index falls back to a strict walk that throws
	const overrun = concat(ascii('JUNK'), u32(0x7fffffff), new Uint8Array(4));
	const second = chunk('00wb', new Uint8Array([5, 6, 7, 8]));
	const entry = (id: string, pos: number) => concat(ascii(id), u32(16), u32(pos + 4), u32(4));
	const entries = [entry('00wb', 0), entry('00wb', first.length + overrun.length)];
	for (const extra of [[], [entry('01dc', 0x40000000)]]) {
		const movi = list('movi', first, overrun, second);
		const idx1 = chunk('idx1', concat(...entries, ...extra));
		using input = new Input({
			source: new BufferSource(chunk('RIFF', concat(ascii('AVI '), hdrl, movi, idx1))),
			formats: [AVI],
		});
		const track = await input.getPrimaryAudioTrack();
		assert(track);
		const cursor = new PacketCursor(track);
		const packets: EncodedPacket[] = [];
		for await (const packet of cursor) {
			packets.push(packet);
		}
		expect(packets.map(packet => [...packet.data])).toEqual([[1, 2, 3, 4, 5, 6, 7, 8]]);
	}
});

test('Dropped video frames', async () => {
	const frame = new Uint8Array([1, 2, 3, 4]);
	const dropped = new Uint8Array(0);
	const format = new Uint8Array(40);
	const view = new DataView(format.buffer);
	view.setUint32(0, 40, true);
	view.setInt32(4, 16, true);
	view.setInt32(8, 16, true);
	format.set(ascii('apch'), 16);

	for (const index of [false, true]) {
		for (const leading of [false, true]) {
			const packets = leading ? [dropped, frame, dropped, frame, dropped, dropped] : [frame, dropped, dropped];
			using input = new Input({
				source: new BufferSource(makeAvi(packets, { video: true, format, index })), formats: [AVI],
			});
			const track = await input.getPrimaryVideoTrack();
			assert(track);
			const expected = leading ? [[0.04, 0.08], [0.12, 0.12]] : [[0, 0.12]];
			for (const metadataOnly of [false, true]) {
				const cursor = new PacketCursor(track, { metadataOnly });
				for (const [timestamp, duration] of expected) {
					const packet = await cursor.next();
					expect(packet?.timestamp).toBeCloseTo(timestamp!);
					expect(packet?.duration).toBeCloseTo(duration!);
					expect(packet?.byteLength).toBe(frame.length);
					if (!metadataOnly) {
						expect(packet?.data).toEqual(frame);
					}
				}
				expect(await cursor.next()).toBeNull();
				expect((await cursor.seekTo(leading ? 0.2 : 0.08))?.timestamp).toBe(leading ? 0.12 : 0);
			}
			expect(await track.getDurationFromMetadata()).toBeCloseTo(leading ? 0.24 : 0.12);
			expect(await track.computeDuration()).toBeCloseTo(leading ? 0.24 : 0.12);
		}
	}
});

test('MPEG-4 Part 2 identification', async () => {
	// An I-VOP, two P-VOPs and another I-VOP; the VOP coding type sits in the top two bits after the start code
	const vop = (type: number) => new Uint8Array([0, 0, 1, 0xb6, type << 6, 0x5a]);
	const frames = [vop(0), vop(1), vop(1), vop(0)];
	const description = new Uint8Array([0, 0, 1, 0xb0, 1]);
	const formatFor = (fourCc: string) => {
		const format = new Uint8Array(40 + description.length);
		const view = new DataView(format.buffer);
		view.setUint32(0, 40, true);
		view.setInt32(4, 16, true);
		view.setInt32(8, 16, true);
		format.set(ascii(fourCc), 16);
		format.set(description, 40);
		return format;
	};
	for (const fourCc of ['XVID', 'DIVX']) {
		using input = new Input({
			source: new BufferSource(makeAvi(frames, { video: true, format: formatFor(fourCc), index: true })),
			formats: [AVI],
		});
		const track = await input.getPrimaryVideoTrack();
		assert(track);
		// Identified under the shared name, with the container's identifier kept and nothing registered
		expect(await track.getCodec()).toBe('mpeg4');
		expect(await track.getInternalCodecId()).toBe(fourCc);
		expect(getAllVideoCodecs()).not.toContain('mpeg4');
		expect(await track.getDecoderConfig()).toEqual({
			codec: 'mpeg4', codedWidth: 16, codedHeight: 16, description,
		});
		// Packet types come from the demuxer's own inspection, and verified key seeking agrees with them
		const cursor = new PacketCursor(track, { verifyKeyPackets: true });
		expect((await cursor.seekToKey(2 / 25))?.sequenceNumber).toBe(0);
		expect((await cursor.seekToKey(3 / 25))?.sequenceNumber).toBe(3);
		const types: string[] = [];
		for await (const packet of new PacketCursor(track)) {
			types.push(packet.type);
		}
		expect(types).toEqual(['key', 'delta', 'delta', 'key']);
	}
	// A single B-VOP makes the whole file unreadable, as with AVC
	using withBFrame = new Input({
		source: new BufferSource(makeAvi([vop(0), vop(2)], { video: true, format: formatFor('XVID'), index: true })),
		formats: [AVI],
	});
	expect(await withBFrame.getTracks()).toEqual([]);
});

test('A corrupt index entry falls back to the scan even when lengths cannot tell', async () => {
	// The length cross-check is blind here: the writer left dwLength at 0, so only the record that an entry failed
	// to validate can force the scan that recovers the second packet
	const hdrl = makeHdrl({ length: 0 });
	const first = chunk('00wb', new Uint8Array([1, 2, 3, 4]));
	const second = chunk('00wb', new Uint8Array([5, 6, 7, 8]));
	const entries = concat(
		concat(ascii('00wb'), u32(16), u32(4), u32(4)),
		// Points outside the movi list, so it cannot be validated
		concat(ascii('00wb'), u32(16), u32(0x40000000), u32(4)),
	);
	const bytes = chunk('RIFF', concat(ascii('AVI '), hdrl, list('movi', first, second), chunk('idx1', entries)));
	using input = new Input({ source: new BufferSource(bytes), formats: [AVI] });
	const track = await input.getPrimaryAudioTrack();
	assert(track);
	expect((await new PacketCursor(track).next())?.data).toEqual(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]));
});

test('An empty stream beside a complete index is empty, not missing', async () => {
	const strh = (type: string, rate: number, length: number, sampleSize: number) => {
		const stream = new Uint8Array(56);
		stream.set(ascii(type));
		const view = new DataView(stream.buffer);
		view.setUint32(20, 1, true);
		view.setUint32(24, rate, true);
		view.setUint32(32, length, true);
		view.setUint32(44, sampleSize, true);
		return stream;
	};
	const videoFormat = new Uint8Array(40);
	const formatView = new DataView(videoFormat.buffer);
	formatView.setUint32(0, 40, true);
	formatView.setInt32(4, 16, true);
	formatView.setInt32(8, 16, true);
	const pcm = concat(u16(1), u16(2), u32(8000), u32(32000), u16(4), u16(16));
	const avih = new Uint8Array(56);
	avih[12] = 0x20; // AVIF_MUSTUSEINDEX
	const hdrl = list(
		'hdrl', chunk('avih', avih),
		// A dummy video stream: no chunks, and a header that says so
		list('strl', chunk('strh', strh('vids', 25, 0, 0)), chunk('strf', videoFormat)),
		list('strl', chunk('strh', strh('auds', 8000, 1, 4)), chunk('strf', pcm)),
	);
	const audio = chunk('01wb', new Uint8Array([1, 2, 3, 4]));
	const movi = list('movi', audio);
	const idx1 = chunk('idx1', concat(ascii('01wb'), u32(16), u32(4), u32(4)));
	using input = new Input({
		source: new BufferSource(chunk('RIFF', concat(ascii('AVI '), hdrl, movi, idx1))),
		formats: [AVI],
	});
	const track = await input.getPrimaryAudioTrack();
	assert(track);
	expect((await new PacketCursor(track).next())?.data).toEqual(new Uint8Array([1, 2, 3, 4]));
	const video = await input.getPrimaryVideoTrack();
	assert(video);
	expect(await new PacketCursor(video).next()).toBeNull();
});

test('An empty stream with no index at all still forces a scan', async () => {
	// The guard on the change above: a header left at zero by an interrupted writer must not be believed
	const bytes = makeAvi([new Uint8Array([1, 2, 3, 4])], { zeroLength: true });
	using input = new Input({ source: new BufferSource(bytes), formats: [AVI] });
	const track = await input.getPrimaryAudioTrack();
	assert(track);
	expect((await new PacketCursor(track).next())?.data).toEqual(new Uint8Array([1, 2, 3, 4]));
});

test('Video we cannot describe is dropped, not the file', async () => {
	// A B-frame makes every video timestamp a guess, but it says nothing about the audio or the metadata tags
	const strh = (type: string, rate: number, length: number, sampleSize: number) => {
		const stream = new Uint8Array(56);
		stream.set(ascii(type));
		const view = new DataView(stream.buffer);
		view.setUint32(20, 1, true);
		view.setUint32(24, rate, true);
		view.setUint32(32, length, true);
		view.setUint32(44, sampleSize, true);
		return stream;
	};
	const videoFormat = new Uint8Array(40);
	const formatView = new DataView(videoFormat.buffer);
	formatView.setUint32(0, 40, true);
	formatView.setInt32(4, 16, true);
	formatView.setInt32(8, 16, true);
	videoFormat.set(ascii('XVID'), 16);
	const pcm = concat(u16(1), u16(2), u32(8000), u32(32000), u16(4), u16(16));
	const hdrl = list(
		'hdrl', chunk('avih', new Uint8Array(56)),
		list('strl', chunk('strh', strh('vids', 25, 1, 0)), chunk('strf', videoFormat)),
		list('strl', chunk('strh', strh('auds', 8000, 1, 4)), chunk('strf', pcm)),
		list('INFO', chunk('INAM', ascii('Title\0'))),
	);
	// A B-VOP: 0xb6 starts a VOP, and the top two bits of the next byte are the coding type
	const bFrame = concat(ascii('00dc'), u32(5), new Uint8Array([0, 0, 1, 0xb6, 0x80]), new Uint8Array(1));
	const movi = list('movi', bFrame, chunk('01wb', new Uint8Array([1, 2, 3, 4])));
	using input = new Input({
		source: new BufferSource(chunk('RIFF', concat(ascii('AVI '), hdrl, movi))),
		formats: [AVI],
	});
	expect(await input.getPrimaryVideoTrack()).toBeNull();
	const track = await input.getPrimaryAudioTrack();
	assert(track);
	expect((await new PacketCursor(track).next())?.data).toEqual(new Uint8Array([1, 2, 3, 4]));
	expect((await input.getMetadataTags()).title).toBe('Title');
});

test('MP3 junk between frames is stepped over', async () => {
	const frame = new Uint8Array(417);
	frame.set([255, 251, 144, 0]);
	const format = concat(u16(0x55), u16(2), u32(44100), u32(16000), u16(1), u16(0), u16(0));
	// Eight zero bytes where a frame should start, then two real ones
	const bytes = makeAvi([concat(new Uint8Array(8), frame, frame)], { format });
	using input = new Input({ source: new BufferSource(bytes), formats: [AVI] });
	const track = await input.getPrimaryAudioTrack();
	assert(track);
	const cursor = new PacketCursor(track);
	expect((await cursor.next())?.data).toEqual(frame);
	expect((await cursor.next())?.data).toEqual(frame);
	expect(await cursor.next()).toBeNull();
});

test('A partial trailing MP3 frame is dropped', async () => {
	const frame = new Uint8Array(417);
	frame.set([255, 251, 144, 0]);
	const format = concat(u16(0x55), u16(2), u32(44100), u32(16000), u16(1), u16(0), u16(0));
	const bytes = makeAvi([concat(frame, frame, frame.subarray(0, 100))], { format });
	using input = new Input({ source: new BufferSource(bytes), formats: [AVI] });
	const track = await input.getPrimaryAudioTrack();
	assert(track);
	expect(await track.computeDuration()).toBe(2304 / 44100);
});

test('FourCCs are matched without regard to case', async () => {
	for (const fourCc of ['avc1', 'AVC1', 'Avc1']) {
		const format = new Uint8Array(40);
		const view = new DataView(format.buffer);
		view.setUint32(0, 40, true);
		view.setInt32(4, 16, true);
		view.setInt32(8, 16, true);
		format.set(ascii(fourCc), 16);
		const idr = new Uint8Array([0, 0, 0, 1, 0x65, 0xb8]);
		using input = new Input({
			source: new BufferSource(makeAvi([idr], { format, video: true, index: true })), formats: [AVI],
		});
		const track = await input.getPrimaryVideoTrack();
		assert(track);
		expect(await track.getCodec()).toBe('avc');
		expect(await track.getInternalCodecId()).toBe(fourCc);
	}
});

test('AVISF_DISABLED marks a track non-default rather than hiding it', async () => {
	const bytes = makeAvi([new Uint8Array([1, 2, 3, 4])], { disabled: true });
	using input = new Input({ source: new BufferSource(bytes), formats: [AVI] });
	const track = await input.getPrimaryAudioTrack();
	assert(track);
	expect((await track.getDisposition()).default).toBe(false);
	using enabled = new Input({
		source: new BufferSource(makeAvi([new Uint8Array([1, 2, 3, 4])])), formats: [AVI],
	});
	const other = await enabled.getPrimaryAudioTrack();
	assert(other);
	expect((await other.getDisposition()).default).toBe(true);
});

test('Index entries that do not carry timing are still packets', async () => {
	// AVIIF_NOTIME marks a chunk that does not affect the stream's timing, not one to skip
	const bytes = makeAvi([new Uint8Array([1, 2, 3, 4])], { index: true, mustUseIndex: true, entryFlags: 0x110 });
	using input = new Input({ source: new BufferSource(bytes), formats: [AVI] });
	const track = await input.getPrimaryAudioTrack();
	assert(track);
	expect((await new PacketCursor(track).next())?.data).toEqual(new Uint8Array([1, 2, 3, 4]));
});

test('Padding after the last NAL unit is left to the decoder', async () => {
	const description = new Uint8Array([1, 0x42, 0, 0x1e, 0xff]);
	const format = new Uint8Array(40 + description.length);
	const view = new DataView(format.buffer);
	view.setUint32(0, 40, true);
	view.setInt32(4, 16, true);
	view.setInt32(8, 16, true);
	format.set(ascii('H264'), 16);
	format.set(description, 40);
	// One length-prefixed IDR unit, then four bytes of padding that read as a zero length
	const packet = concat(u32be(2), new Uint8Array([0x65, 0xb8]), new Uint8Array(4));
	using input = new Input({
		source: new BufferSource(makeAvi([packet], { format, video: true, index: true })), formats: [AVI],
	});
	const track = await input.getPrimaryVideoTrack();
	assert(track);
	expect((await new PacketCursor(track).next())?.type).toBe('key');
});

test('Unknown codecs and conversion', async () => {
	const toMp4 = async (input: Input) => {
		const output = new Output({ target: new BufferTarget(), format: new Mp4OutputFormat() });
		const conversion = await Conversion.init({ input, output, showWarnings: false });
		return conversion.discardedTracks.map(discarded => discarded.reason);
	};

	// A FourCC the demuxer doesn't know keeps its packets readable, but nothing can be done with them
	const format = new Uint8Array(40);
	const view = new DataView(format.buffer);
	view.setUint32(0, 40, true);
	view.setInt32(4, 16, true);
	view.setInt32(8, 16, true);
	format.set(ascii('XXXX'), 16);
	const packets = [new Uint8Array([1, 2]), new Uint8Array([3, 4])];
	const unknownBytes = makeAvi(packets, { video: true, format, index: true });
	using unknown = new Input({ source: new BufferSource(unknownBytes), formats: [AVI] });
	const unknownTrack = await unknown.getPrimaryVideoTrack();
	assert(unknownTrack);
	expect(await unknownTrack.getCodec()).toBe(null);
	expect(await unknownTrack.getInternalCodecId()).toBe('XXXX');
	expect((await new PacketCursor(unknownTrack).seekToFirst())?.data).toEqual(new Uint8Array([1, 2]));
	expect(await toMp4(unknown)).toEqual(['unknown_source_codec']);

	// An identified codec without a decoder can't be transcoded
	const mpeg4Bytes = readFileSync(new URL('./fixtures/mpeg4-mp3.avi', import.meta.url));
	using undecodable = new Input({ source: new BufferSource(mpeg4Bytes), formats: [AVI] });
	expect(await toMp4(undecodable)).toEqual(['undecodable_source_codec']);

	// With a decoder it can be decoded, but Node has nothing to encode it into
	class Mpeg4Decoder extends CustomVideoDecoder {
		static override supports(codec: VideoCodec) { return codec === 'mpeg4'; }
		init() {}
		decode() {}
		flush() {}
		close() {}
	}
	registerDecoder(Mpeg4Decoder);
	using decodable = new Input({ source: new BufferSource(mpeg4Bytes), formats: [AVI] });
	expect(await toMp4(decodable)).toEqual(['no_encodable_target_codec']);

	// AVC and PCM go straight through
	const avcBytes = readFileSync(new URL('./fixtures/avc-pcm.avi', import.meta.url));
	using passthrough = new Input({ source: new BufferSource(avcBytes), formats: [AVI] });
	expect(await toMp4(passthrough)).toEqual([]);
});
