// A real, fetchable manifest URL per group (e.g. /api/manifest?group=carchat)
// instead of a browser-generated blob: URL. iOS Safari's "Add to Home
// Screen" has a history of not reliably respecting blob: manifest links,
// silently falling back to whatever manifest.json said at the site root -
// which is exactly what caused the "No group specified" bug. A genuine
// same-origin URL like this one doesn't have that problem.
module.exports = (req, res) => {
  const group = (req.query.group || "").toString().slice(0, 100);
  const customIcon = (req.query.icon || "").toString();
  // Only accept a genuine https URL here - anything else falls back to the
  // default icons rather than risk passing through something malformed.
  const iconUrl = /^https:\/\//.test(customIcon) ? customIcon : null;

  const manifest = {
    name: group || "Group Chat",
    short_name: (group || "GroupChat").slice(0, 12),
    start_url: group ? `/${group}` : "/",
    display: "standalone",
    background_color: "#f5f5f4",
    theme_color: "#075E54",
    icons: iconUrl
      ? [
          { src: iconUrl, sizes: "192x192", type: "image/png" },
          { src: iconUrl, sizes: "512x512", type: "image/png" },
        ]
      : [
          { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
        ],
  };

  res.setHeader("Content-Type", "application/manifest+json");
  res.status(200).json(manifest);
};
