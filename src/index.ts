/*!
 * Copyright (c) 2026-present, Don Carignan and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { CustomDemuxer, CustomInputFormat, DemuxerContext, readAscii } from 'mediabunny';
import { AviDemuxer } from './avi-demuxer';

/**
 * AVI input format, including OpenDML files.
 *
 * Do not instantiate this class; use the {@link AVI} singleton instead.
 * @group mediabunny-avi
 * @public
 */
export class AviInputFormat extends CustomInputFormat {
	async canReadInput(context: DemuxerContext) {
		let slice = context.reader.requestSlice(0, 12);
		if (slice instanceof Promise) {
			slice = await slice;
		}
		if (!slice || readAscii(slice, 4) !== 'RIFF') {
			return false;
		}
		slice.skip(4);
		return readAscii(slice, 4) === 'AVI ';
	}

	createDemuxer(context: DemuxerContext): CustomDemuxer {
		return new AviDemuxer(context);
	}

	get name() {
		return 'AVI';
	}

	get mimeType() {
		return 'video/x-msvideo';
	}
}

/**
 * Singleton instance of {@link AviInputFormat}.
 * @group mediabunny-avi
 * @public
 */
export const AVI = /* #__PURE__ */ new AviInputFormat();
