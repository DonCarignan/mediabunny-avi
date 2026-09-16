/*!
 * Adapted from Mediabunny's media player example:
 * https://github.com/Vanilagy/mediabunny/tree/main/examples/media-player
 *
 * Copyright (c) 2026-present, Vanilagy and contributors
 * Copyright (c) 2026-present, Don Carignan and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Changed from the original: AVI is added to the format list, the sample file is an AVI, the control icons are
 * inline SVG rather than images, the Mediabunny site chrome is gone, the registered extensions and the opened
 * file's container and tracks are listed, and a track that cannot be played names its codec. The playback logic
 * is untouched.
 */

import {
	ALL_FORMATS,
	AudioSampleCursor,
	BlobSource,
	Input,
	type InputFormat,
	type InputTrack,
	UrlSource,
	VideoSampleCursor,
} from 'mediabunny';
import { AVI } from 'mediabunny-avi';

/**
 * The container extensions this player registers. These add containers, not codecs; a codec extension would be a
 * separate registry. Mediabunny reads its built-in formats out of `ALL_FORMATS`;
 * everything here is a container it cannot read on its own. Adding another extension package means adding a row:
 * the format list, the file picker, the sample buttons and the list on the page are all derived from this.
 */
type ContainerExtension = {
	/** The input format the package exports */
	format: InputFormat;
	/** What the container is called */
	name: string;
	/** The package that provides it */
	packageName: string;
	/** Where that package lives */
	packageUrl: string;
	/** File extensions, for the file picker */
	fileExtensions: string[];
	/** A sample served next to this page, if there is one */
	sample?: { label: string; url: string };
};

const EXTENSIONS: ContainerExtension[] = [
	{
		format: AVI,
		name: 'AVI',
		packageName: 'mediabunny-avi',
		packageUrl: 'https://github.com/DonCarignan/mediabunny-avi',
		fileExtensions: ['.avi'],
		sample: { label: 'Play sample AVI', url: './sample.avi' },
	},
];

/** Lists the registered extensions, and gives each sample its own button. */
const renderExtensions = () => {
	for (const extension of EXTENSIONS) {
		const item = document.createElement('li');

		const name = document.createElement('strong');
		name.textContent = extension.name;
		item.append(name);

		const link = document.createElement('a');
		link.href = extension.packageUrl;
		link.target = '_blank';
		link.rel = 'noreferrer';
		link.append(Object.assign(document.createElement('code'), { textContent: extension.packageName }));
		item.append(link);

		extensionsElement.append(item);

		if (extension.sample) {
			const button = document.createElement('button');
			button.textContent = extension.sample.label;
			button.addEventListener('click', () => void initMediaPlayer(extension.sample!.url));
			buttonsElement.prepend(button);
		}
	}
};

const selectMediaButton = document.querySelector('#select-file') as HTMLButtonElement;
const loadUrlButton = document.querySelector('#load-url') as HTMLButtonElement;
const fileNameElement = document.querySelector('#file-name') as HTMLParagraphElement;
const buttonsElement = document.querySelector('#buttons') as HTMLDivElement;
const extensionsElement = document.querySelector('#extensions') as HTMLUListElement;
const infoPanel = document.querySelector('#info-panel') as HTMLElement;
const infoFile = document.querySelector('#info-file') as HTMLDListElement;
const infoTracks = document.querySelector('#info-tracks') as HTMLDivElement;
const infoTags = document.querySelector('#info-tags') as HTMLDListElement;
const infoTagsWrapper = document.querySelector('#info-tags-wrapper') as HTMLDivElement;
const horizontalRule = document.querySelector('hr') as HTMLHRElement;
const loadingElement = document.querySelector('#loading-element') as HTMLParagraphElement;
const playerContainer = document.querySelector('#player') as HTMLDivElement;
const canvas = document.querySelector('canvas') as HTMLCanvasElement;
const controlsElement = document.querySelector('#controls') as HTMLDivElement;
const playButton = document.querySelector('#play-button') as HTMLButtonElement;
const playIcon = document.querySelector('#play-icon') as HTMLSpanElement;
const pauseIcon = document.querySelector('#pause-icon') as HTMLSpanElement;
const currentTimeElement = document.querySelector('#current-time') as HTMLSpanElement;
const durationElement = document.querySelector('#duration') as HTMLSpanElement;
const progressBarContainer = document.querySelector('#progress-bar-container') as HTMLDivElement;
const progressBar = document.querySelector('#progress-bar') as HTMLDivElement;
const volumeBarContainer = document.querySelector('#volume-bar-container') as HTMLDivElement;
const volumeBar = document.querySelector('#volume-bar') as HTMLDivElement;
const volumeIconWrapper = document.querySelector('#volume-icon-wrapper') as HTMLDivElement;
const volumeButton = document.querySelector('#volume-button') as HTMLButtonElement;
const liveDot = document.querySelector('#live-dot') as HTMLButtonElement;
const fullscreenButton = document.querySelector('#fullscreen-button') as HTMLButtonElement;
const errorElement = document.querySelector('#error-element') as HTMLDivElement;
const warningElement = document.querySelector('#warning-element') as HTMLDivElement;

const context = canvas.getContext('2d')!;

let audioContext: AudioContext | null = null;
let gainNode: GainNode | null = null;

let fileLoaded = false;
let videoCursor: VideoSampleCursor | null = null;
let audioCursor: AudioSampleCursor | null = null;

let firstTimestamp = 0;
let endTimestamp = 0;
let isRelativeToUnixEpoch = false;
/** The value of the audio context's currentTime the moment the playback was started. */
let audioContextStartTime: number | null = null;
let playing = false;
/** The timestamp within the media file when the playback was started. */
let playbackTimeAtStart = 0;

const queuedAudioNodes: Set<AudioBufferSourceNode> = new Set();

let liveRefreshIntervalId = -1;

let draggingProgressBar = false;
let volume = 0.7;
let draggingVolumeBar = false;
let volumeMuted = false;

/** === INIT LOGIC === */

// AVI names video codecs with a FourCC and audio codecs with a numeric WAVEFORMATEX tag. When a track cannot be
// played, report that identifier next to Mediabunny's own codec name, so the message says which codec is at fault.
const describeCodec = async (track: InputTrack) => {
	// getCodec lives on the video and audio subclasses, not on the base track
	const codecOf = async () => {
		if (track.isVideoTrack()) {
			return track.getCodec();
		}
		if (track.isAudioTrack()) {
			return track.getCodec();
		}
		return null;
	};
	const internalCodecId = await track.getInternalCodecId();
	const containerId = typeof internalCodecId === 'number'
		? `0x${internalCodecId.toString(16).padStart(4, '0')}`
		: typeof internalCodecId === 'string' ? internalCodecId : null;
	const codec = await codecOf();
	if (codec && containerId) {
		return `${codec}, ${containerId}`;
	}
	return codec ?? containerId ?? 'unrecognized';
};

/** Adds one label/value row to a definition list. */
const addRow = (list: HTMLDListElement, label: string, value: string) => {
	const dt = document.createElement('dt');
	dt.textContent = label;
	const dd = document.createElement('dd');
	dd.textContent = value;
	list.append(dt, dd);
};

/**
 * Describes the opened file: which container was recognised, which extension read it if any, and what each track
 * turned out to be. Everything here comes from metadata the demuxer has already parsed, so nothing walks packets.
 */
const showFileInfo = async (input: Input) => {
	infoFile.replaceChildren();
	infoTracks.replaceChildren();
	infoTags.replaceChildren();

	const format = await input.getFormat();
	const extension = EXTENSIONS.find(candidate => candidate.format === format);
	addRow(infoFile, 'Container', extension ? `${format.name} (read by ${extension.packageName})` : format.name);
	addRow(infoFile, 'Read by', extension ? 'Extension package' : 'Mediabunny built-in');
	addRow(infoFile, 'MIME type', await input.getMimeType());
	if (endTimestamp) {
		addRow(infoFile, 'Duration', formatTimestamp(endTimestamp));
	}

	for (const track of await input.getTracks()) {
		const card = document.createElement('dl');
		card.className = 'track';

		addRow(card, 'Track', `${track.id} — ${track.type}`);
		addRow(card, 'Codec', await describeCodec(track));

		if (track.isVideoTrack()) {
			const coded = `${await track.getCodedWidth()}×${await track.getCodedHeight()}`;
			const display = `${await track.getDisplayWidth()}×${await track.getDisplayHeight()}`;
			addRow(card, 'Resolution', coded === display ? coded : `${display} (coded ${coded})`);
			const rotation = await track.getRotation();
			if (rotation) {
				addRow(card, 'Rotation', `${rotation}°`);
			}
		}

		if (track.isAudioTrack()) {
			addRow(card, 'Channels', String(await track.getNumberOfChannels()));
			addRow(card, 'Sample rate', `${await track.getSampleRate()} Hz`);
		}

		const language = await track.getLanguageCode();
		if (language && language !== 'und') {
			addRow(card, 'Language', language);
		}

		// The honest part: a codec can be identified and still have nowhere to decode it
		const codec = await track.getCodec();
		addRow(card, 'Decodable', codec === null
			? 'No — container codec not recognised'
			: (await track.canDecode()) ? 'Yes' : 'No — no decoder available in this browser');

		infoTracks.append(card);
	}

	const tags = await input.getMetadataTags();
	const raw = tags.raw ?? {};
	const entries = Object.entries(raw).filter(([, value]) => typeof value === 'string' && value.length > 0);
	for (const [key, value] of entries) {
		addRow(infoTags, key, value as string);
	}
	infoTagsWrapper.style.display = entries.length > 0 ? '' : 'none';

	infoPanel.style.display = '';
};

const initMediaPlayer = async (resource: File | string) => {
	try {
		// First, dispose any ongoing playback:

		if (playing) {
			pause();
		}

		void videoCursor?.close();
		void audioCursor?.close();

		fileLoaded = false;
		fileNameElement.textContent = resource instanceof File ? resource.name : resource;
		horizontalRule.style.display = '';
		loadingElement.style.display = '';
		playerContainer.style.display = 'none';
		errorElement.textContent = '';
		warningElement.textContent = '';
		infoPanel.style.display = 'none';
		liveDot.style.display = 'none';
		clearTimeout(liveRefreshIntervalId);

		// Create an Input from the resource
		const input = new Input({
			source: typeof resource === 'string'
				? new UrlSource(resource)
				: new BlobSource(resource),
			// Every built-in format, plus each registered extension
			formats: [...ALL_FORMATS, ...EXTENSIONS.map(extension => extension.format)],
		});

		let videoTrack = await input.getPrimaryVideoTrack();
		let audioTrack = await input.getPrimaryAudioTrack();

		const tracks = [videoTrack, audioTrack].filter(t => t !== null);

		firstTimestamp = Math.max(
			await input.getFirstTimestamp(tracks),
			0,
		);
		endTimestamp = await input.getDurationFromMetadata(tracks, { skipLiveWait: true })
			?? await input.computeDuration(tracks, { skipLiveWait: true });
		isRelativeToUnixEpoch = (await Promise.all(tracks.map(t => t.isRelativeToUnixEpoch()))).some(Boolean);
		playbackTimeAtStart = firstTimestamp;

		// Configure the time display elements accordingly
		const timestampFontSize = isRelativeToUnixEpoch ? '12px' : '';
		const timestampWhiteSpace = isRelativeToUnixEpoch ? 'pre' : '';
		const timestampTextAlign = isRelativeToUnixEpoch ? 'center' : '';
		currentTimeElement.style.fontSize = timestampFontSize;
		currentTimeElement.style.whiteSpace = timestampWhiteSpace;
		currentTimeElement.style.textAlign = timestampTextAlign;
		durationElement.style.fontSize = timestampFontSize;
		durationElement.style.whiteSpace = timestampWhiteSpace;
		durationElement.style.textAlign = timestampTextAlign;
		durationElement.textContent = formatTimestamp(endTimestamp);

		let problemMessage = '';

		if (videoTrack) {
			if (await videoTrack.getCodec() === null) {
				problemMessage += `Unsupported video codec (${await describeCodec(videoTrack)}). `;
				videoTrack = null;
			} else if (!(await videoTrack.canDecode())) {
				problemMessage += `Unable to decode the video track (${await describeCodec(videoTrack)}). `;
				videoTrack = null;
			}
		}

		if (audioTrack) {
			if (await audioTrack.getCodec() === null) {
				problemMessage += `Unsupported audio codec (${await describeCodec(audioTrack)}). `;
				audioTrack = null;
			} else if (!(await audioTrack.canDecode())) {
				problemMessage += `Unable to decode the audio track (${await describeCodec(audioTrack)}). `;
				audioTrack = null;
			}
		}

		if (!videoTrack && !audioTrack) {
			if (!problemMessage) {
				problemMessage = 'No audio or video track found.';
			}

			throw new Error(problemMessage);
		}

		if (problemMessage) {
			warningElement.textContent = problemMessage;
		}

		// eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
		const AudioContext = window.AudioContext || (window as any).webkitAudioContext;

		// We must create the audio context with the matching sample rate for correct acoustic results
		// (especially for low-sample rate files)
		audioContext = new AudioContext({ sampleRate: await audioTrack?.getSampleRate() });
		gainNode = audioContext.createGain();
		gainNode.connect(audioContext.destination);
		updateVolume();

		const videoCanBeTransparent = videoTrack
			? await videoTrack.canBeTransparent()
			: false;

		playerContainer.style.background = videoCanBeTransparent ? 'transparent' : '';

		if (videoTrack) {
			videoCursor = new VideoSampleCursor(videoTrack);
			await videoCursor.seekToFirst();
		}
		if (audioTrack) {
			audioCursor = new AudioSampleCursor(audioTrack);
			await audioCursor.seekToFirst();
		}

		// Show the canvas if there's a video track, otherwise hide it
		if (videoTrack) {
			canvas.style.display = '';
			canvas.width = await videoTrack.getDisplayWidth();
			canvas.height = await videoTrack.getDisplayHeight();
		} else {
			canvas.style.display = 'none';
		}

		// Show volume controls if there's an audio track, otherwise hide them
		if (audioTrack) {
			volumeButton.style.display = '';
			volumeBarContainer.style.display = '';
		} else {
			volumeButton.style.display = 'none';
			volumeBarContainer.style.display = 'none';
		}

		fileLoaded = true;

		if (audioContext.state === 'running') {
			// Start playback automatically if the audio context permits
			// await play();
		}

		loadingElement.style.display = 'none';
		playerContainer.style.display = '';

		await showFileInfo(input);

		if (!videoCursor) {
			// If there's only an audio track, always show the controls
			controlsElement.style.opacity = '1';
			controlsElement.style.pointerEvents = '';
			playerContainer.style.cursor = '';
		}

		const refreshIntervals = await Promise.all(tracks.map(t => t.getLiveRefreshInterval()));
		const nonNullIntervals = refreshIntervals.filter(x => x !== null);

		if (nonNullIntervals.length > 0) {
			// At least one track is live! This means that we'll need to continually refresh the end timestamp of the
			// media to allow continuous live playback.

			const interval = Math.min(...nonNullIntervals);
			liveDot.style.display = '';
			liveDot.onclick = () => {
				void seekToTime(endTimestamp - interval * 1.5);
			};

			const scheduleLiveRefresh = () => {
				// eslint-disable-next-line @typescript-eslint/no-misused-promises
				liveRefreshIntervalId = window.setTimeout(async () => {
					endTimestamp = await input.getDurationFromMetadata(tracks, { skipLiveWait: true })
						?? await input.computeDuration(tracks, { skipLiveWait: true });
					durationElement.textContent = formatTimestamp(endTimestamp);

					// Check if we're still live
					const stillLive = await Promise.all(tracks.map(t => t.isLive()));
					if (stillLive.every(live => !live)) {
						liveDot.style.display = 'none';
					} else {
						scheduleLiveRefresh();
					}
				}, interval * 1000);
			};
			scheduleLiveRefresh();
		}
	} catch (error) {
		console.error(error);

		errorElement.textContent = String(error);
		loadingElement.style.display = 'none';
		playerContainer.style.display = 'none';
	}
};

/** === VIDEO RENDERING LOGIC === */

/** Runs every frame and updates the canvas if possible. */
const render = (requestFrame = true) => {
	if (fileLoaded) {
		const playbackTime = getPlaybackTime();
		if (playbackTime >= endTimestamp) {
			// Pause playback once the end is reached
			pause();
			playbackTimeAtStart = endTimestamp;
		}

		if (videoCursor) {
			if (videoCursor.isIdle()) {
				// The seek is instant if the frame has already been decoded under the hood; if it is not, we'll just
				// render the old frame until the new one is ready.
				void videoCursor.seekTo(playbackTime);
			}

			context.clearRect(0, 0, canvas.width, canvas.height);
			if (videoCursor.current) {
				videoCursor.current.drawWithFit(context, { fit: 'contain' });
			}
		}

		if (!draggingProgressBar) {
			updateProgressBarTime(playbackTime);
		}
	}

	if (requestFrame) {
		requestAnimationFrame(() => render());
	}
};
render();

// Also call the render function on an interval to make sure the video keeps updating even if the tab isn't visible
setInterval(() => render(false), 500);

/** === AUDIO PLAYBACK LOGIC === */

let currentAudioIteratorId = 0;

/** Loops over the audio buffer iterator, scheduling the audio to be played in the audio context. */
const runAudioIterator = async () => {
	if (!audioCursor) {
		return;
	}

	const id = ++currentAudioIteratorId;

	// To play back audio, we loop over all audio chunks (typically very short) of the file and play them at the correct
	// timestamp. The result is a continuous, uninterrupted audio signal.
	for await (const sample of audioCursor) {
		if (id !== currentAudioIteratorId) {
			break;
		}

		const node = audioContext!.createBufferSource();
		node.buffer = sample.toAudioBuffer();
		node.connect(gainNode!);

		let startTimestamp = audioContextStartTime! + sample.timestamp - playbackTimeAtStart;
		// Round timestamp to the context's sample boundaries to prevent subsample audio glitches
		startTimestamp = Math.round(audioContext!.sampleRate * startTimestamp) / audioContext!.sampleRate;

		// Two cases: Either, the audio starts in the future or in the past
		if (startTimestamp >= audioContext!.currentTime) {
			// If the audio starts in the future, easy, we just schedule it
			node.start(startTimestamp);
		} else {
			// If it starts in the past, then let's only play the audible section that remains from here on out
			node.start(audioContext!.currentTime, audioContext!.currentTime - startTimestamp);
		}

		queuedAudioNodes.add(node);
		node.onended = () => {
			queuedAudioNodes.delete(node);
		};

		// If we're more than a second ahead of the current playback time, let's slow down the loop until time has
		// passed.
		if (sample.timestamp - getPlaybackTime() >= 1) {
			await new Promise<void>((resolve) => {
				const timeoutId = setInterval(() => {
					if (sample.timestamp - getPlaybackTime() < 1 || id !== currentAudioIteratorId) {
						clearInterval(timeoutId);
						resolve();
					}
				}, 100);
			});

			// This check is required to prevent advancing the cursor when it is no longer in our control
			if (id !== currentAudioIteratorId) {
				break;
			}
		}
	}
};

/** === PLAYBACK CONTROL LOGIC === */

/** Returns the current playback time in the media file. */
const getPlaybackTime = () => {
	if (playing) {
		// To ensure perfect audio-video sync, we always use the audio context's clock to determine playback time, even
		// when there is no audio track.
		return audioContext!.currentTime - audioContextStartTime! + playbackTimeAtStart;
	} else {
		return playbackTimeAtStart;
	}
};

const play = async () => {
	if (audioContext!.state === 'suspended') {
		await audioContext!.resume();
	}

	if (getPlaybackTime() === endTimestamp) {
		// If we're at the end, let's snap back to the start
		playbackTimeAtStart = firstTimestamp;
		await videoCursor?.seekTo(firstTimestamp);
	}

	audioContextStartTime = audioContext!.currentTime;
	playing = true;

	if (audioCursor) {
		// Start the audio iterator
		void audioCursor.seekTo(getPlaybackTime());
		void runAudioIterator();
	}

	playIcon.style.display = 'none';
	pauseIcon.style.display = '';
};

const pause = () => {
	playbackTimeAtStart = getPlaybackTime();
	playing = false;

	currentAudioIteratorId++; // This stops any ongoing cursor iteration

	// Stop all audio nodes that were already queued to play
	for (const node of queuedAudioNodes) {
		node.stop();
	}
	queuedAudioNodes.clear();

	playIcon.style.display = '';
	pauseIcon.style.display = 'none';
};

const togglePlay = () => {
	if (playing) {
		pause();
	} else {
		void play();
	}
};

const seekToTime = async (seconds: number) => {
	updateProgressBarTime(seconds);

	const wasPlaying = playing;

	if (wasPlaying) {
		pause();
	}

	playbackTimeAtStart = seconds;

	await videoCursor?.seekTo(seconds);

	if (wasPlaying && playbackTimeAtStart < endTimestamp) {
		void play();
	}
};

/** === PROGRESS BAR LOGIC === */

const updateProgressBarTime = (seconds: number) => {
	currentTimeElement.textContent = formatTimestamp(seconds);
	progressBar.style.width = `${((seconds - firstTimestamp) / (endTimestamp - firstTimestamp)) * 100}%`;
};

progressBarContainer.addEventListener('pointerdown', (event) => {
	draggingProgressBar = true;
	progressBarContainer.setPointerCapture(event.pointerId);

	const rect = progressBarContainer.getBoundingClientRect();
	const completion = Math.max(Math.min((event.clientX - rect.left) / rect.width, 1), 0);
	updateProgressBarTime(firstTimestamp + completion * (endTimestamp - firstTimestamp));

	clearTimeout(hideControlsTimeout);

	window.addEventListener('pointerup', (event) => {
		draggingProgressBar = false;
		progressBarContainer.releasePointerCapture(event.pointerId);

		const rect = progressBarContainer.getBoundingClientRect();
		const completion = Math.max(Math.min((event.clientX - rect.left) / rect.width, 1), 0);
		const newTime = firstTimestamp + completion * (endTimestamp - firstTimestamp);

		void seekToTime(newTime);
		showControlsTemporarily();
	}, { once: true });
});

progressBarContainer.addEventListener('pointermove', (event) => {
	if (draggingProgressBar) {
		const rect = progressBarContainer.getBoundingClientRect();
		const completion = Math.max(Math.min((event.clientX - rect.left) / rect.width, 1), 0);
		updateProgressBarTime(firstTimestamp + completion * (endTimestamp - firstTimestamp));
	}
});

/** === VOLUME CONTROL LOGIC === */

const updateVolume = () => {
	const actualVolume = volumeMuted ? 0 : volume;

	volumeBar.style.width = `${actualVolume * 100}%`;
	gainNode!.gain.value = actualVolume ** 2; // Quadratic for more fine-grained control

	const iconNumber = volumeMuted ? 0 : Math.ceil(1 + 3 * volume);
	for (let i = 0; i < volumeIconWrapper.children.length; i++) {
		const icon = volumeIconWrapper.children[i] as HTMLElement;
		icon.style.display = i === iconNumber ? '' : 'none';
	}
};

volumeBarContainer.addEventListener('pointerdown', (event) => {
	draggingVolumeBar = true;
	volumeBarContainer.setPointerCapture(event.pointerId);

	const rect = volumeBarContainer.getBoundingClientRect();
	volume = Math.max(Math.min((event.clientX - rect.left) / rect.width, 1), 0);
	volumeMuted = false;
	updateVolume();

	clearTimeout(hideControlsTimeout);

	window.addEventListener('pointerup', (event) => {
		draggingVolumeBar = false;
		volumeBarContainer.releasePointerCapture(event.pointerId);

		const rect = volumeBarContainer.getBoundingClientRect();
		volume = Math.max(Math.min((event.clientX - rect.left) / rect.width, 1), 0);
		updateVolume();

		showControlsTemporarily();
	}, { once: true });
});

volumeButton.addEventListener('click', () => {
	volumeMuted = !volumeMuted;
	updateVolume();
});

volumeBarContainer.addEventListener('pointermove', (event) => {
	if (draggingVolumeBar) {
		const rect = volumeBarContainer.getBoundingClientRect();
		volume = Math.max(Math.min((event.clientX - rect.left) / rect.width, 1), 0);
		updateVolume();
	}
});

/** === CONTROL UI LOGIC === */

const showControlsTemporarily = () => {
	if (!videoCursor) {
		// Shouldn't run if there's only an audio track
		return;
	}

	controlsElement.style.opacity = '1';
	controlsElement.style.pointerEvents = '';
	playerContainer.style.cursor = '';

	clearTimeout(hideControlsTimeout);
	hideControlsTimeout = window.setTimeout(() => {
		if (draggingProgressBar) {
			return;
		}

		hideControls();
		playerContainer.style.cursor = 'none';
	}, 2000);
};

const hideControls = () => {
	controlsElement.style.opacity = '0';
	controlsElement.style.pointerEvents = 'none';
};
hideControls();

let hideControlsTimeout = -1;
playerContainer.addEventListener('pointermove', (event) => {
	if (event.pointerType !== 'touch') {
		showControlsTemporarily();
	}
});
playerContainer.addEventListener('pointerleave', (event) => {
	if (!videoCursor) {
		// Shouldn't run if there's only an audio track
		return;
	}

	if (draggingProgressBar || draggingVolumeBar || event.pointerType === 'touch') {
		return;
	}

	hideControls();
	clearTimeout(hideControlsTimeout);
});

/** === EVENT LISTENERS === */

playButton.addEventListener('click', togglePlay);
window.addEventListener('keydown', (e) => {
	if (!fileLoaded) {
		return;
	}

	if (e.code === 'Space' || e.code === 'KeyK') {
		togglePlay();
	} else if (e.code === 'KeyF') {
		fullscreenButton.click();
	} else if (e.code === 'ArrowLeft') {
		const newTime = Math.max(getPlaybackTime() - 5, firstTimestamp);
		void seekToTime(newTime);
	} else if (e.code === 'ArrowRight') {
		const newTime = Math.min(getPlaybackTime() + 5, endTimestamp);
		void seekToTime(newTime);
	} else if (e.code === 'KeyM') {
		volumeButton.click();
	} else {
		return;
	}

	showControlsTemporarily();
	e.preventDefault();
});

fullscreenButton.addEventListener('click', () => {
	if (document.fullscreenElement) {
		void document.exitFullscreen();
	} else {
		playerContainer.requestFullscreen().catch((e) => {
			console.error('Failed to enter fullscreen mode:', e);
		});
	}
});

// I'm sorry for this
const isTouchDevice = () => {
	return 'ontouchstart' in window;
};

playerContainer.addEventListener('click', () => {
	if (isTouchDevice()) {
		if (controlsElement.style.opacity === '1') {
			hideControls();
		} else {
			showControlsTemporarily();
		}
	} else {
		togglePlay();
	}
});
controlsElement.addEventListener('click', (event) => {
	// Make sure this does NOT toggle play
	event.stopPropagation();
	showControlsTemporarily();
});

/** === UTILS === */

const formatTimestamp = (seconds: number) => {
	if (isRelativeToUnixEpoch) {
		const iso = new Date(seconds * 1000).toISOString();
		return iso.replace('T', '\n');
	}

	return formatSeconds(seconds);
};

const formatSeconds = (seconds: number) => {
	const showMilliseconds = window.innerWidth >= 640;

	seconds = Math.round(seconds * 1000) / 1000; // Round to milliseconds

	const hours = Math.floor(seconds / 3600);
	const minutes = Math.floor((seconds % 3600) / 60);
	const remainingSeconds = Math.floor(seconds % 60);
	const millisecs = Math.floor(1000 * seconds % 1000).toString().padStart(3, '0');

	let result: string;
	if (hours > 0) {
		result = `${hours}:${minutes.toString().padStart(2, '0')}`
			+ `:${remainingSeconds.toString().padStart(2, '0')}`;
	} else {
		result = `${minutes.toString().padStart(2, '0')}:${remainingSeconds.toString().padStart(2, '0')}`;
	}

	if (showMilliseconds) {
		result += `.${millisecs}`;
	}

	return result;
};

window.addEventListener('resize', () => {
	if (endTimestamp) {
		updateProgressBarTime(getPlaybackTime());
		durationElement.textContent = formatTimestamp(endTimestamp);
	}
});

/** === FILE SELECTION LOGIC === */

selectMediaButton.addEventListener('click', () => {
	const fileInput = document.createElement('input');
	fileInput.type = 'file';
	fileInput.accept = [
		'video/*', 'video/x-matroska', 'video/mp2t', '.ts', 'audio/*', 'audio/aac',
		...EXTENSIONS.flatMap(extension => extension.fileExtensions),
	].join(',');
	fileInput.addEventListener('change', () => {
		const file = fileInput.files?.[0];
		if (!file) {
			return;
		}

		void initMediaPlayer(file);
	});

	fileInput.click();
});

loadUrlButton.addEventListener('click', () => {
	const url = prompt(
		'Please enter a URL of a media file. Note that it must be HTTPS and support cross-origin requests, so have the'
		+ ' right CORS headers set.',
	);
	if (!url) {
		return;
	}

	void initMediaPlayer(url);
});

document.addEventListener('dragover', (event) => {
	event.preventDefault();
	event.dataTransfer!.dropEffect = 'copy';
});

document.addEventListener('drop', (event) => {
	event.preventDefault();
	const files = event.dataTransfer?.files;
	const file = files && files.length > 0 ? files[0] : undefined;
	if (file) {
		void initMediaPlayer(file);
	}
});

renderExtensions();
