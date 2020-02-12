// Adapted from https://github.com/mapbox/pixelmatch
//              https://github.com/mapbox/pixelmatch/blob/master/index.js
//
//
// ISC License
// 
// Copyright (c) 2019, Mapbox
// 
// Permission to use, copy, modify, and/or distribute this software for any purpose
// with or without fee is hereby granted, provided that the above copyright notice
// and this permission notice appear in all copies.
// 
// THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
// REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND
// FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
// INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS
// OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER
// TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF
// THIS SOFTWARE.
//
import {
    interpolateInferno,
} from 'd3-scale-chromatic'
import { rgb } from 'd3-color'


const defaultOptions = {
    threshold: 0.1,         // matching threshold (0 to 1); smaller is more sensitive
    includeAA: false,       // whether to skip anti-aliasing detection

    colorScale: false,      // will display the pixels that differ using a colorscale

    alpha: 0.1,             // opacity of original image in diff ouput
    aaColor: [255, 255, 0], // color of anti-aliased pixels in diff output
    diffColor: [255, 0, 0]  // color of different pixels in diff output
};



function pixelmatch(img1, img2, output, width, height, options_) {
    if (!isPixelData(img1) || !isPixelData(img2) || (output && !isPixelData(output)))
        throw new Error('Image data: Uint8Array, Uint8ClampedArray or Buffer expected.');
    if (img1.length !== img2.length || (output && output.length !== img1.length))
        throw new Error('Image sizes do not match.');
    if (img1.length !== width * height * 4)
        throw new Error('Image data size does not match width/height.');
    if (!!!output)
        throw new Error('You must provide an output image');

    const options = {
        ...defaultOptions,
        ...options_,
    };

    // check if images are identical
    const len = width * height;
    const a32 = new Uint32Array(img1.buffer, img1.byteOffset, len);
    const b32 = new Uint32Array(img2.buffer, img2.byteOffset, len);
    let identical = true;
    for (let i = 0; i < len; i++) {
        if (a32[i] !== b32[i]) { identical = false; break; }
    }
    if (identical) { // fast path if identical
        for (let i = 0; i < len; i++) drawGrayPixel(img1, 4 * i, options.alpha, output);
        return 0;
    }

    // maximum acceptable square distance between two colors;
    // 35215 is the maximum possible value for the YIQ difference metric
    const threshold2 = options.threshold * options.threshold;
    const maxDelta = 35215 * threshold2;

    let diff = 0;
    const [aaR, aaG, aaB] = options.aaColor;
    const [diffR, diffG, diffB] = options.diffColor;

    // let deltas = []
    // compare each pixel of one image against the other one
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const pos = (y * width + x) * 4;
            // squared YUV distance between colors at this pixel position
            let distance = colorDelta(img1, img2, pos, pos)
            let delta = 1 - (distance / 35215 / threshold2);
            // for display, we offer scaling
            let scaled_delta = Math.max(0, Math.min(1, delta));
            // deltas.push(scaled_delta)

            if (options.colorScale) {
              if (scaled_delta > 0.95)
                drawGrayPixel(img1, pos, options.alpha, output)
              else {
                let is_antialiased = antialiased(img1, x, y, width, height, img2) || antialiased(img2, x, y, width, height, img1);
                if (!options.includeAA && is_antialiased) {
                    drawPixel(output, pos, aaR, aaG, aaB);
                } else {
                  let color = rgb(interpolateInferno(scaled_delta))
                  drawPixel(output, pos, color.r, color.g, color.b);                    
                }
              }
              continue
            }


            // the color difference is above the threshold
            if (delta > maxDelta) {
                // check it's a real rendering difference or just anti-aliasing
                if (!options.includeAA && (antialiased(img1, x, y, width, height, img2) ||
                                           antialiased(img2, x, y, width, height, img1))) {
                    // one of the pixels is anti-aliasing; draw as yellow and do not count as difference
                    drawPixel(output, pos, aaR, aaG, aaB);

                } else {
                    // found substantial difference not caused by anti-aliasing; draw it as red
                    drawPixel(output, pos, diffR, diffG, diffB);
                    diff++;
                }

            } else {
                // pixels are similar; draw background as grayscale image blended with white
                drawGrayPixel(img1, pos, options.alpha, output);
            }
        }
    }
    // console.log(deltas)
    // console.log("min:", deltas.reduce((a, b) => Math.min(a,b),  10))
    // console.log("max:", deltas.reduce((a, b) => Math.max(a,b), -10))
    // return the number of different pixels
    return diff;
}

function isPixelData(arr) {
    // work around instanceof Uint8Array not working properly in some Jest environments
    return ArrayBuffer.isView(arr) && arr.constructor.BYTES_PER_ELEMENT === 1;
}

// check if a pixel is likely a part of anti-aliasing;
// based on "Anti-aliased Pixel and Intensity Slope Detector" paper by V. Vysniauskas, 2009

function antialiased(img, x1, y1, width, height, img2) {
    const x0 = Math.max(x1 - 1, 0);
    const y0 = Math.max(y1 - 1, 0);
    const x2 = Math.min(x1 + 1, width - 1);
    const y2 = Math.min(y1 + 1, height - 1);
    const pos = (y1 * width + x1) * 4;
    let zeroes = x1 === x0 || x1 === x2 || y1 === y0 || y1 === y2 ? 1 : 0;
    let min = 0;
    let max = 0;
    let minX, minY, maxX, maxY;

    // go through 8 adjacent pixels
    for (let x = x0; x <= x2; x++) {
        for (let y = y0; y <= y2; y++) {
            if (x === x1 && y === y1) continue;

            // brightness delta between the center pixel and adjacent one
            const delta = colorDelta(img, img, pos, (y * width + x) * 4, true);

            // count the number of equal, darker and brighter adjacent pixels
            if (delta === 0) {
                zeroes++;
                // if found more than 2 equal siblings, it's definitely not anti-aliasing
                if (zeroes > 2) return false;

            // remember the darkest pixel
            } else if (delta < min) {
                min = delta;
                minX = x;
                minY = y;

            // remember the brightest pixel
            } else if (delta > max) {
                max = delta;
                maxX = x;
                maxY = y;
            }
        }
    }

    // if there are no both darker and brighter pixels among siblings, it's not anti-aliasing
    if (min === 0 || max === 0) return false;

    // if either the darkest or the brightest pixel has 3+ equal siblings in both images
    // (definitely not anti-aliased), this pixel is anti-aliased
    return (hasManySiblings(img, minX, minY, width, height) && hasManySiblings(img2, minX, minY, width, height)) ||
           (hasManySiblings(img, maxX, maxY, width, height) && hasManySiblings(img2, maxX, maxY, width, height));
}

// check if a pixel has 3+ adjacent pixels of the same color.
function hasManySiblings(img, x1, y1, width, height) {
    const x0 = Math.max(x1 - 1, 0);
    const y0 = Math.max(y1 - 1, 0);
    const x2 = Math.min(x1 + 1, width - 1);
    const y2 = Math.min(y1 + 1, height - 1);
    const pos = (y1 * width + x1) * 4;
    let zeroes = x1 === x0 || x1 === x2 || y1 === y0 || y1 === y2 ? 1 : 0;

    // go through 8 adjacent pixels
    for (let x = x0; x <= x2; x++) {
        for (let y = y0; y <= y2; y++) {
            if (x === x1 && y === y1) continue;

            const pos2 = (y * width + x) * 4;
            if (img[pos] === img[pos2] &&
                img[pos + 1] === img[pos2 + 1] &&
                img[pos + 2] === img[pos2 + 2] &&
                img[pos + 3] === img[pos2 + 3]) zeroes++;

            if (zeroes > 2) return true;
        }
    }

    return false;
}

// calculate color difference according to the paper "Measuring perceived color difference
// using YIQ NTSC transmission color space in mobile applications" by Y. Kotsarenko and F. Ramos

function colorDelta(img1, img2, k, m, yOnly) {
    let r1 = img1[k + 0];
    let g1 = img1[k + 1];
    let b1 = img1[k + 2];
    let a1 = img1[k + 3];

    let r2 = img2[m + 0];
    let g2 = img2[m + 1];
    let b2 = img2[m + 2];
    let a2 = img2[m + 3];

    if (a1 === a2 && r1 === r2 && g1 === g2 && b1 === b2) return 0;

    if (a1 < 255) {
        a1 /= 255;
        r1 = blend(r1, a1);
        g1 = blend(g1, a1);
        b1 = blend(b1, a1);
    }

    if (a2 < 255) {
        a2 /= 255;
        r2 = blend(r2, a2);
        g2 = blend(g2, a2);
        b2 = blend(b2, a2);
    }

    const y = rgb2y(r1, g1, b1) - rgb2y(r2, g2, b2);

    if (yOnly) return y; // brightness difference only

    const i = rgb2i(r1, g1, b1) - rgb2i(r2, g2, b2);
    const q = rgb2q(r1, g1, b1) - rgb2q(r2, g2, b2);

    return 0.5053 * y * y + 0.299 * i * i + 0.1957 * q * q;
}

function rgb2y(r, g, b) { return r * 0.29889531 + g * 0.58662247 + b * 0.11448223; }
function rgb2i(r, g, b) { return r * 0.59597799 - g * 0.27417610 - b * 0.32180189; }
function rgb2q(r, g, b) { return r * 0.21147017 - g * 0.52261711 + b * 0.31114694; }

// blend semi-transparent color with white
function blend(c, a) {
    return 255 + (c - 255) * a;
}

function drawPixel(output, pos, r, g, b) {
    output[pos + 0] = r;
    output[pos + 1] = g;
    output[pos + 2] = b;
    output[pos + 3] = 255;
}

function drawGrayPixel(img, pos, alpha, output) {
    const r = img[pos + 0];
    const g = img[pos + 1];
    const b = img[pos + 2];
    const y = rgb2y(r, g, b)
    const val = blend(y, alpha * img[pos + 3] / 255);
    drawPixel(output, pos, val, val, val);
}

// function drawAlphaPixel(output, pos, r, g, b, alpha) {
//     const r = img[pos + 0];
//     const g = img[pos + 1];
//     const b = img[pos + 2];
//     const y = rgb2y(r, g, b)
// }


export default pixelmatch;