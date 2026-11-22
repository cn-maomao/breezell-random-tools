# Changelog

## 0.4.0

- Group all nine tools into Random generation, Encoding & security, and Parsing & time, using category and tool dropdowns.
- Add English/Simplified Chinese "Copy AI prompt" templates. Copy only validated public numeric, boolean and enum options; omit input text, tokens, results, free-form character rules, affixes and port exclusions. Users paste prompts manually; the plugin neither sends chat messages nor reads chat/editor/clipboard content.
- Register `rt_password`, `rt_key`, `rt_port`, `rt_uuid`, `rt_hash`, `rt_timestamp`, `rt_base64`, `rt_url` and `rt_jwt` locally for chat, agent and entanglement under `plugin:cn-maomao.random-tools`, with the sole declared permission `agent.tools`. Refused or unavailable tool registration does not prevent the manual panel.
- Keep AI-generated passwords and keys in the masked plugin panel, including username-mode values; return only metadata and a panel notice to the model. Document that other tool inputs and outputs enter the model conversation and must not contain secrets.
- Change the publisher/plugin identity from `local-tools.random-tools` to `cn-maomao.random-tools`, add the public source repository and author metadata, and keep the MIT license. Existing users should uninstall the old identity to avoid duplicate entries.
- Update English/Chinese marketplace documentation and add a Chinese publishing guide distinguishing GitHub releases from market submission and maintainer approval. Real-host acceptance and market review remain required; this entry is not a claim that the plugin is already listed.

## 0.3.0

- Add UUID v4 generation, text hashes, timestamp conversion, Base64/Hex conversion, HTTP(S) URL parsing and JWT decoding.
- Keep processing offline with bounded input/output and structured errors; no new runtime dependencies or permissions.
- Expand compact tool navigation and multiline output; mask potentially sensitive text and clear tool inputs on switch/sign-out.
- JWT decoding never verifies signatures; MD5/SHA-1 are compatibility hashes, not password storage algorithms.

## 0.2.0

- Add a localized right-aligned status-bar shortcut; create the Webview only on demand.
- Clear host-held secrets when the panel is hidden and dispose panel listeners on close.
- Use request-local cryptographic buffers and reusable category counts; bound pathological generation work.
- Update only the revealed batch row instead of walking every result.
- Reduce form spacing and heading size with compact layout B, retaining native themes, focus indicators and 32px control heights.

## 0.1.0

- Initial local-development release with passwords/username preset, JWT HMAC secrets and candidate ports.
- Custom formats, exclusions, unique batches and explicit clipboard actions.
- Compact English/Simplified Chinese panel with strict CSP and no secret persistence.
- Cryptographic generation and boundary tests; official Breezell Devkit packaging.
- Marketplace publication remains pending publisher identity, source repository and host acceptance testing.
