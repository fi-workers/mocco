---
'@mocco/cli': minor
---

Renamed from `@mocco/ota-cli`, and the commands are now grouped by product: `mocco ota publish` rather than `mocco-ota publish`. Nothing was published under the old name, so there is no alias to carry — and OTA is one product line of several, so a flat command surface would have been claimed by whichever shipped first and left every later one reading as an exception. A new product adds `mocco <product> <verb>` and nothing else moves.
