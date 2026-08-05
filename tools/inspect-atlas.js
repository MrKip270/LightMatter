// LightMatter — one-off tool: inspect the World Atlas GeoTIFF
//
// Run this BEFORE writing the real build script. Same discipline we used with
// Open-Meteo: never write a parser against data you haven't looked at. A
// GeoTIFF's geometry (origin, pixel size, row order, no-data value) is not
// guaranteed by the format — it's declared in the header, and guessing wrong
// silently produces a map that's flipped, shifted, or off by half a pixel.
//
// This script reads ONLY the header plus a few pixels. It never loads the
// 2.9 GB of raster into memory.
//
// Usage:
//   node tools/inspect-atlas.js /path/to/World_Atlas_2015.tif

const { fromFile } = require("geotiff");

// A few known places to sample, spanning the full brightness range.
// If the geometry is being read correctly, these should come out ordered
// roughly bright -> dark. If they don't, the georeferencing is wrong.
const PROBES = [
  { name: "Chicago Loop", lat: 41.8827, lon: -87.6233 },
  { name: "Manhattan", lat: 40.7580, lon: -73.9855 },
  { name: "Tromsø, Norway", lat: 69.6492, lon: 18.9553 },
  { name: "Cherry Springs SP, PA", lat: 41.6628, lon: -77.8164 },
  { name: "Mid-Pacific (should be ~0)", lat: 0.0, lon: -150.0 },
];

async function main() {
  const filePath = process.argv[2];
  if (!filePath) {
    console.error("Usage: node tools/inspect-atlas.js <path-to-World_Atlas_2015.tif>");
    process.exit(1);
  }

  const tiff = await fromFile(filePath);
  const image = await tiff.getImage();

  const width = image.getWidth();
  const height = image.getHeight();

  // The origin is the top-left corner in map coordinates (degrees here).
  // The resolution is [xSize, ySize] per pixel. ySize is normally NEGATIVE,
  // because raster rows run north -> south while latitude increases south ->
  // north. Getting this sign wrong flips the map vertically, which is the
  // single most common georeferencing bug.
  const [originX, originY] = image.getOrigin();
  const [resX, resY] = image.getResolution();
  const bbox = image.getBoundingBox();

  console.log("=== Geometry ===");
  console.log("size (px)        :", width, "x", height);
  console.log("origin (deg)     :", originX, originY);
  console.log("resolution (deg) :", resX, resY);
  console.log("  1/resX         :", 1 / resX, "(expect ~120 for 30 arcsec)");
  console.log("bbox W,S,E,N     :", bbox.map((v) => Number(v.toFixed(4))).join(", "));

  console.log("\n=== Pixel format ===");
  console.log("samples/pixel    :", image.getSamplesPerPixel());
  console.log("bits/sample      :", image.getBitsPerSample());
  console.log("sample format    :", image.getSampleFormat(), "(1=uint, 2=int, 3=float)");
  console.log("no-data value    :", image.getGDALNoData());
  console.log("pixelIsArea      :", image.pixelIsArea());

  console.log("\n=== Layout (how it streams) ===");
  console.log("tile  w x h      :", image.getTileWidth(), "x", image.getTileHeight());
  console.log("block w x h      :", image.getBlockWidth(), "x", image.getBlockHeight());
  console.log("  If tile height is small (e.g. 1 or a few rows), the file is");
  console.log("  striped and we can stream it row-block by row-block.");

  // Convert a lat/lon to pixel column/row using the declared geometry.
  // This is the exact arithmetic the real build script and route will use, so
  // proving it here on known places is the whole point of this tool.
  function toPixel(lat, lon) {
    return {
      col: Math.floor((lon - originX) / resX),
      row: Math.floor((lat - originY) / resY), // resY is negative
    };
  }

  console.log("\n=== Probe pixels (artificial brightness, mcd/m^2) ===");
  for (const probe of PROBES) {
    const { col, row } = toPixel(probe.lat, probe.lon);

    if (col < 0 || col >= width || row < 0 || row >= height) {
      console.log(`${probe.name.padEnd(28)} outside raster (col=${col}, row=${row})`);
      continue;
    }

    // readRasters with a window reads ONLY those pixels off disk.
    // Window is [left, top, right, bottom] in pixel coordinates.
    const [band] = await image.readRasters({
      window: [col, row, col + 1, row + 1],
    });

    const artificial = band[0];

    // The documented conversion chain (lightpollutionmap.info FAQ #31):
    //   natural sky      = 0.171168465 mcd/m^2  (= 22.00 mag/arcsec^2)
    //   total            = artificial + natural
    //   SQM (mag/arcsec) = log10(total / 108000000) / -0.4
    const NATURAL = 0.171168465;
    const total = artificial + NATURAL;
    const sqm = Math.log10(total / 108000000) / -0.4;

    console.log(
      `${probe.name.padEnd(28)} col=${String(col).padStart(6)} row=${String(row).padStart(5)}` +
        `  artificial=${artificial.toExponential(3).padStart(11)}` +
        `  SQM=${sqm.toFixed(2)}`
    );
  }

  console.log("\nSanity check: city SQM should land around 17-18,");
  console.log("a dark-sky park around 21-22, and open ocean at ~22.00.");
}

main().catch((err) => {
  console.error("Failed:", err.message);
  process.exit(1);
});
