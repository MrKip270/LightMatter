// LightMatter — one-off tool: downsample the World Atlas into a small grid
//
// Input:  World_Atlas_2015.tif  (2.9 GB, 43200 x 17406, float32, mcd/m^2)
// Output: backend/data/lightpollution.bin  (~23 MB, 5400 x 2176, uint16 SQM)
//
// Run this ONCE. The output is committed; the input never is.
//
// Usage:
//   node tools/build-lightpollution.js ../lightmatter_storage/World_Atlas_2015.tif

const fs = require("fs");
const path = require("path");
const { fromFile } = require("geotiff");

// How many source pixels per output pixel, on each axis.
// 8 x 30 arcsec = 4 arcmin, roughly 7 km at the equator.
const FACTOR = 8;

// Natural sky brightness, i.e. what the sky would be with zero artificial
// light: 22.00 mag/arcsec^2 expressed in mcd/m^2. The atlas stores ARTIFICIAL
// light only, so this has to be added back before converting to SQM.
const NATURAL_MCD = 0.171168465;

// SQM is stored as an integer to halve the file size: uint16 = round(SQM * 1000).
// SQM spans roughly 15-22, so scaled it spans 15000-22000 — comfortably inside
// uint16's 0-65535. That leaves 0 free to mean "no data".
const SQM_SCALE = 1000;
const NO_DATA = 0;

// Convert artificial brightness (mcd/m^2) to magnitudes per square arc-second.
// Chain documented at lightpollutionmap.info FAQ #31.
function toSqm(artificialMcd) {
  const total = artificialMcd + NATURAL_MCD;
  return Math.log10(total / 108000000) / -0.4;
}

async function main() {
  const inputPath = process.argv[2];
  if (!inputPath) {
    console.error("Usage: node tools/build-lightpollution.js <World_Atlas_2015.tif>");
    process.exit(1);
  }

  const outputPath = path.join(__dirname, "..", "backend", "data", "lightpollution.bin");
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  const tiff = await fromFile(inputPath);
  const image = await tiff.getImage();

  const srcWidth = image.getWidth();
  const srcHeight = image.getHeight();
  const [originX, originY] = image.getOrigin();
  const [resX, resY] = image.getResolution();

  // Output dimensions. Math.ceil, not Math.floor: 17406 / 8 is 2175.75, and
  // flooring would silently discard the bottom 6 rows of the planet. The last
  // output row is a PARTIAL block averaged over 6 source rows instead of 8 —
  // handled below by clamping the inner loops rather than assuming a full block.
  const outWidth = Math.ceil(srcWidth / FACTOR);
  const outHeight = Math.ceil(srcHeight / FACTOR);

  console.log(`source : ${srcWidth} x ${srcHeight}`);
  console.log(`output : ${outWidth} x ${outHeight}  (factor ${FACTOR})`);
  console.log(`bytes  : ${((outWidth * outHeight * 2) / 1e6).toFixed(1)} MB\n`);

  const grid = new Uint16Array(outWidth * outHeight);

  // Read in horizontal bands. A band is FACTOR * 16 = 128 source rows, which
  // exactly matches the file's 128-pixel tile height, so we never ask the
  // decoder for a partial tile. Each band is ~22 MB in memory; the full raster
  // would be ~3 GB, which is the entire reason for streaming.
  const BAND_ROWS = FACTOR * 16;

  for (let bandTop = 0; bandTop < srcHeight; bandTop += BAND_ROWS) {
    const bandBottom = Math.min(bandTop + BAND_ROWS, srcHeight);

    const [band] = await image.readRasters({
      window: [0, bandTop, srcWidth, bandBottom],
    });
    const bandHeight = bandBottom - bandTop;

    // Walk the output cells that live inside this band.
    for (let blockTop = bandTop; blockTop < bandBottom; blockTop += FACTOR) {
      const outRow = blockTop / FACTOR;
      const blockBottom = Math.min(blockTop + FACTOR, srcHeight);

      for (let outCol = 0; outCol < outWidth; outCol++) {
        const blockLeft = outCol * FACTOR;
        const blockRight = Math.min(blockLeft + FACTOR, srcWidth);

        // Average in LINEAR brightness (mcd/m^2), never in magnitudes.
        // Magnitudes are logarithmic, so averaging them computes a geometric
        // mean, which under-weights bright cells and would make cities look
        // darker than they are. Average linear, convert once at the end.
        let sum = 0;
        let count = 0;

        for (let y = blockTop; y < blockBottom; y++) {
          const rowOffset = (y - bandTop) * srcWidth;
          for (let x = blockLeft; x < blockRight; x++) {
            const value = band[rowOffset + x];
            // No-data is -FLT_MAX (-3.4e38). Averaging even one of those in
            // would drag the whole block to nonsense, so drop anything
            // negative — artificial brightness is physically >= 0.
            if (value >= 0) {
              sum += value;
              count++;
            }
          }
        }

        const outIndex = outRow * outWidth + outCol;
        if (count === 0) {
          grid[outIndex] = NO_DATA;
        } else {
          const sqm = toSqm(sum / count);
          grid[outIndex] = Math.round(sqm * SQM_SCALE);
        }
      }
    }

    const pct = ((bandBottom / srcHeight) * 100).toFixed(1);
    process.stdout.write(`\rprocessed ${bandBottom}/${srcHeight} rows (${pct}%)`);
  }

  console.log("\n");

  // Self-describing header: a JSON blob prefixed by its own length.
  // Why not hardcode the geometry in the route? Because the whole point of the
  // "swappable dataset" decision is that a newer atlas can replace this file
  // without editing code. The route reads the geometry from the file it is
  // given, so a different resolution or extent just works.
  const header = Buffer.from(
    JSON.stringify({
      format: "LightMatter light pollution grid",
      version: 1,
      source: "Falchi et al. 2016, World Atlas of Artificial Night Sky Brightness",
      sourceDoi: "10.5880/GFZ.1.4.2016.001",
      license: "CC BY-NC 4.0",
      dataYear: 2015,
      units: "magnitudes per square arc-second (SQM), stored as uint16 = SQM * scale",
      scale: SQM_SCALE,
      noData: NO_DATA,
      downsampleFactor: FACTOR,
      width: outWidth,
      height: outHeight,
      // Geometry of the OUTPUT grid. Origin is unchanged (top-left corner of
      // the first source pixel); pixel size grows by the downsample factor.
      originX,
      originY,
      resX: resX * FACTOR,
      resY: resY * FACTOR,
    }),
    "utf8"
  );

  const lengthPrefix = Buffer.alloc(4);
  lengthPrefix.writeUInt32LE(header.length, 0);

  fs.writeFileSync(
    outputPath,
    Buffer.concat([lengthPrefix, header, Buffer.from(grid.buffer)])
  );

  const stats = fs.statSync(outputPath);
  console.log(`wrote ${outputPath}`);
  console.log(`size  ${(stats.size / 1e6).toFixed(1)} MB`);

  // Verify against the same probes the inspect tool used. If downsampling
  // broke something, these move.
  const probes = [
    ["Chicago Loop", 41.8827, -87.6233],
    ["Manhattan", 40.758, -73.9855],
    ["Tromsø, Norway", 69.6492, 18.9553],
    ["Cherry Springs SP, PA", 41.6628, -77.8164],
    ["Mid-Pacific", 0.0, -150.0],
  ];

  console.log("\nprobe check (compare to inspect-atlas output):");
  for (const [name, lat, lon] of probes) {
    const col = Math.floor((lon - originX) / (resX * FACTOR));
    const row = Math.floor((lat - originY) / (resY * FACTOR));
    const raw = grid[row * outWidth + col];
    const sqm = raw === NO_DATA ? null : raw / SQM_SCALE;
    console.log(`  ${name.padEnd(24)} SQM=${sqm === null ? "no data" : sqm.toFixed(2)}`);
  }
}

main().catch((err) => {
  console.error("\nFailed:", err.message);
  process.exit(1);
});
