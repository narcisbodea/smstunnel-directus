# Publishing `@narcisbodea/smstunnel-directus`

The owner does every step below himself (his GitHub account `narcisbodea` and his npm account `narcisbodea`, which
confirms with Windows Hello). Nothing here needs a stored token, and the Directus Marketplace has no form: it lists
extensions from npm.

## The name

`@narcisbodea/smstunnel-directus` puts SMSTunnel first, under the scope that already holds `@narcisbodea/smstunnel-sdk`.
It was free on npm on 3 November 2026. Directus' own convention, `directus-extension-<name>`, would put Directus' name
first, so it isn't used. The Marketplace builds the title from the name without the scope: it will read
**Smstunnel Directus** (Directus' title formatter); the description and the `sms` icon say the rest.

## 1. GitHub

1. Create the public repository `narcisbodea/smstunnel-directus` (no README, no license: they're here).
2. Push this folder:
   ```bash
   git remote add origin https://github.com/narcisbodea/smstunnel-directus.git
   git push -u origin main
   ```
3. Wait for the **CI** workflow to go green (unit tests on Node 22, 24 and 26, typecheck, build, a check that the
   sandboxed bundle imports only `directus:api`, `npm pack --dry-run`).
4. In the repository's **About** box, add the topics `directus`, `directus-extension`, `sms`, `smstunnel`.

## 2. npm: the first version, by hand

npm can attach a trusted publisher only to a package that already exists, so 1.0.0 goes out from this folder:

```bash
npm ci
npm test
npm pack --dry-run   # dist/api.js, dist/app.js, README.md, CHANGELOG.md, LICENSE, package.json; nothing else
npm publish          # prepack runs directus-extension build; confirm with Windows Hello
```

## 3. npm Trusted Publishing for later versions

1. On npmjs.com: the package → **Settings** → **Trusted Publisher** → **GitHub Actions**:
   - Organization or user: `narcisbodea`
   - Repository: `smstunnel-directus`
   - Workflow filename: `release.yml`
   - Environment name: `npm`
2. On GitHub: the repository → **Settings** → **Environments** → **New environment** `npm`:
   - **Required reviewers**: `narcisbodea`;
   - **Deployment branches and tags** → **Selected branches and tags** → add the tag rule `v*`.
3. Back on npmjs.com: **Settings** → **Publishing access** → **Require two-factor authentication and disallow tokens**
   → **Update Package Settings**.

npm asks that a new trusted publisher publishes once within 2 days; the next release does that.

## 4. Later versions

1. Raise `version` in `package.json` **and** `VERSION` in `src/operation.ts` (a unit test checks they match), add the
   entry to `CHANGELOG.md`, commit.
2. `git tag v1.0.1 && git push origin main v1.0.1`
3. Approve the `npm` deployment in the **Actions** tab. The **Release** workflow checks the tag, runs the tests, builds
   and publishes with provenance.

## 5. The Directus Marketplace

What Directus asks (<https://directus.com/docs/guides/extensions/marketplace/publishing>), and where it is here:

| Rule | Here |
| --- | --- |
| The keyword `directus-extension` | In `keywords`. |
| `directus:extension.type` and `.host` | `operation`, `^11.0.0 \|\| ^12.0.0` (tested with 11.17.4 and 12.6.0). |
| A `dist` folder with the built files | `dist/api.js`, `dist/app.js`. |
| API extensions must be sandboxed to be installable with the default `MARKETPLACE_TRUST=sandbox` | `sandbox.enabled: true`; it requests only `request` (GET, POST to `https://smstunnel.io/api/v1/*`) and `log`. |
| Optional icon (a Material Icons name) | `"icon": "sms"`. |
| The npm README is the detail page | Yes; a new npm version updates it. |

There is nothing to submit: the registry reads npm every few hours, and only the latest version is listed. After the
first publish, check <https://registry.directus.com/extensions?search=smstunnel> and, in any Directus 11 or 12,
**Settings → Marketplace → search "SMSTunnel"**. Directus may remove an extension that misbehaves, or on the author's
request (marketplace@directus.com).

Keep the sandbox scope as narrow as it is: a wider one (`https://*`) is meant for development only and isn't needed.
