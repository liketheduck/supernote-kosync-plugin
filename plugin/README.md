# Supernote KOSync plugin (React Native)

The Supernote plugin itself. See the [project README](../README.md) for installation and
[docs/DEVELOPMENT.md](../docs/DEVELOPMENT.md) for architecture and testing.

```bash
npm ci
npm test
npx tsc --noEmit
../tools/build.sh   # builds ../dist/SupernoteKOSync-<version>.snplg
```

`buildPlugin.sh` / `buildPlugin.ps1` are Ratta's packaging scripts from the plugin template;
`tools/build.sh` wraps the shell version and verifies its output.
