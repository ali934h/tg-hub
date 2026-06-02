const STANDARD_HEIGHTS = [144, 240, 360, 480, 720, 1080, 1440, 2160];
const MP3_BITRATES = [128, 192, 320];
const PAGE_SIZE = 8;

function humanSize(bytes) {
  if (!bytes || bytes <= 0) return "";
  const units = ["B", "KB", "MB", "GB"];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `~${n.toFixed(n >= 10 ? 0 : 1)}${units[i]}`;
}

function estimateMp3Bytes(durationSec, bitrateKbps) {
  if (!durationSec || !bitrateKbps) return 0;
  return Math.round((bitrateKbps * 1000 * durationSec) / 8);
}

function shortCodec(codec) {
  if (!codec) return "";
  const main = codec.split(".")[0];
  return main || codec;
}

function buildMainMenu(probeInfo) {
  const rows = [];

  rows.push([{ label: "🎵 Audio (MP3)", data: "a:mp3" }]);

  if (probeInfo.hasVideo) {
    const videoHeights = Array.isArray(probeInfo.videoHeights)
      ? probeInfo.videoHeights
      : [];
    const available = videoHeights.map((v) => v.height);
    let selected;
    if (available.length > 0) {
      const standardSubset = STANDARD_HEIGHTS.filter((h) =>
        available.includes(h),
      );
      const max = available[available.length - 1];
      selected = [...standardSubset];
      if (!selected.includes(max)) selected.push(max);
      selected = [...new Set(selected)].sort((a, b) => a - b);
    } else if (probeInfo.maxHeight && probeInfo.maxHeight > 0) {
      selected = STANDARD_HEIGHTS.filter((h) => h <= probeInfo.maxHeight);
      if (!selected.includes(probeInfo.maxHeight))
        selected.push(probeInfo.maxHeight);
    } else {
      selected = [];
    }

    if (selected.length > 0) {
      const videoButtons = selected.map((h) => ({
        label: `🎬 ${h}p`,
        data: `v:${h}`,
      }));
      while (videoButtons.length) {
        rows.push(videoButtons.splice(0, 2));
      }
    } else {
      rows.push([{ label: "🎬 Best video", data: "v:0" }]);
    }
  }

  rows.push([
    { label: "📂 All Video", data: "all_v" },
    { label: "📂 All Audio", data: "all_a" },
  ]);
  rows.push([{ label: "❌ Cancel", data: "cancel" }]);
  return rows;
}

function paginate(items, page) {
  const totalPages = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
  const safePage = Math.max(0, Math.min(page, totalPages - 1));
  const start = safePage * PAGE_SIZE;
  const end = Math.min(items.length, start + PAGE_SIZE);
  return {
    page: safePage,
    totalPages,
    slice: items.slice(start, end),
    startIndex: start,
  };
}

function navRow(kind, page, totalPages) {
  const row = [];
  if (page > 0) {
    row.push({ label: "⬅️ Prev", data: `pg:${kind}:${page - 1}` });
  }
  row.push({ label: "🔙 Back", data: "back" });
  if (page < totalPages - 1) {
    row.push({ label: "Next ▶️", data: `pg:${kind}:${page + 1}` });
  }
  return row;
}

function videoFormatLabel(v) {
  const parts = [];
  if (v.ext) parts.push(v.ext);
  if (v.width && v.height) parts.push(`${v.width}x${v.height}`);
  else if (v.height) parts.push(`${v.height}p`);
  const sz = humanSize(v.sizeBytes);
  if (sz) parts.push(sz);
  const codec = shortCodec(v.vcodec);
  if (codec) parts.push(codec);
  if (v.fps && v.fps >= 30) parts.push(`${Math.round(v.fps)}fps`);
  return `🎬 ${parts.join(" | ")}`;
}

function buildAllVideoMenu(probeInfo, page = 0) {
  const rows = [];
  const videoFormats = Array.isArray(probeInfo.videoFormats)
    ? probeInfo.videoFormats
    : [];

  if (videoFormats.length === 0) {
    rows.push([{ label: "🎬 Best video", data: "v:0" }]);
    rows.push([
      { label: "🔙 Back", data: "back" },
      { label: "❌ Cancel", data: "cancel" },
    ]);
    return rows;
  }

  const { page: cur, totalPages, slice, startIndex } = paginate(
    videoFormats,
    page,
  );
  slice.forEach((v, i) => {
    rows.push([
      { label: videoFormatLabel(v), data: `v:idx:${startIndex + i}` },
    ]);
  });

  rows.push(navRow("v", cur, totalPages));
  rows.push([{ label: "❌ Cancel", data: "cancel" }]);
  return rows;
}

function audioFormatLabel(a) {
  const parts = [];
  if (a.ext) parts.push(a.ext);
  parts.push("audio");
  const sz = humanSize(a.sizeBytes);
  if (sz) parts.push(sz);
  const codec = shortCodec(a.codec);
  if (codec) parts.push(codec);
  if (a.abr) parts.push(`${Math.round(a.abr)}k`);
  return `🎧 ${parts.join(" | ")}`;
}

function buildAllAudioMenu(probeInfo, page = 0) {
  const duration = probeInfo.duration || 0;
  const audioFormats = Array.isArray(probeInfo.audioFormats)
    ? probeInfo.audioFormats
    : [];

  const items = [];
  audioFormats.forEach((a, i) => {
    items.push({ label: audioFormatLabel(a), data: `a:idx:${i}` });
  });
  for (const br of MP3_BITRATES) {
    const size = humanSize(estimateMp3Bytes(duration, br));
    items.push({
      label: size ? `🎵 MP3 ${br}k | ${size}` : `🎵 MP3 ${br}k`,
      data: `a:mp3:${br}`,
    });
  }
  const bestMp3Size = humanSize(estimateMp3Bytes(duration, 245));
  items.push({
    label: bestMp3Size ? `🎵 MP3 Best | ${bestMp3Size}` : "🎵 MP3 Best",
    data: "a:mp3",
  });

  const rows = [];
  if (items.length === 0) {
    rows.push([{ label: "🎵 Audio (MP3)", data: "a:mp3" }]);
    rows.push([
      { label: "🔙 Back", data: "back" },
      { label: "❌ Cancel", data: "cancel" },
    ]);
    return rows;
  }

  const { page: cur, totalPages, slice } = paginate(items, page);
  for (const it of slice) {
    rows.push([{ label: it.label, data: it.data }]);
  }

  rows.push(navRow("a", cur, totalPages));
  rows.push([{ label: "❌ Cancel", data: "cancel" }]);
  return rows;
}

module.exports = {
  buildMenu: buildMainMenu,
  buildMainMenu,
  buildAllVideoMenu,
  buildAllAudioMenu,
  PAGE_SIZE,
};
