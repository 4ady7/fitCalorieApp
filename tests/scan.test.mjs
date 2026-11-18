import assert from 'node:assert/strict';
import test from 'node:test';
import { PNG } from 'pngjs';
import {
  BarcodeFormat,
  BinaryBitmap,
  DecodeHintType,
  GlobalHistogramBinarizer,
  HybridBinarizer,
  MultiFormatReader,
  RGBLuminanceSource,
} from '@zxing/library';

test('decodes a generated EAN-13 barcode image', async () => {
  const bwipjs = (await import('bwip-js')).default;
  const png = await bwipjs.toBuffer({
    bcid: 'ean13',
    text: '3017620422003',
    scale: 4,
    height: 18,
    includetext: false,
    paddingwidth: 24,
    paddingheight: 24,
    backgroundcolor: 'FFFFFF',
  });
  const image = PNG.sync.read(png);
  const luminances = new Uint8ClampedArray(image.width * image.height);
  for (let index = 0, pixel = 0; index < luminances.length; index += 1, pixel += 4) {
    luminances[index] = (image.data[pixel] + image.data[pixel + 1] + image.data[pixel + 2]) / 3;
  }
  const source = new RGBLuminanceSource(luminances, image.width, image.height);
  const hints = new Map();
  hints.set(DecodeHintType.POSSIBLE_FORMATS, [BarcodeFormat.EAN_13, BarcodeFormat.EAN_8, BarcodeFormat.UPC_A]);
  hints.set(DecodeHintType.TRY_HARDER, true);
  const reader = new MultiFormatReader();
  reader.setHints(hints);
  let text = '';
  const attempts = [new HybridBinarizer(source), new GlobalHistogramBinarizer(source)];
  let lastError;
  for (const binarizer of attempts) {
    try {
      text = reader.decode(new BinaryBitmap(binarizer)).getText();
      break;
    } catch (error) {
      lastError = error;
      reader.reset();
    }
  }
  assert.equal(text, '3017620422003', lastError?.message || 'barcode was not decoded');
});
