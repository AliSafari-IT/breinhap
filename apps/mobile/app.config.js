// Adds build-time facts to app.json. EAS evaluates this when it builds, so the
// date is the day this build was made; the About screen shows it.
module.exports = ({ config }) => ({
  ...config,
  extra: { ...config.extra, buildDate: new Date().toISOString().slice(0, 10) },
});
