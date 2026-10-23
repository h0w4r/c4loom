# Third-party notices

C4Loom's original code is distributed under the MIT license in `LICENSE`.
Third-party components retain their own licenses and notices.

| Component | Role | Upstream |
| --- | --- | --- |
| Structurizr | DSL parsing, static workspace export and native C1-C3 visualization | [structurizr/structurizr](https://github.com/structurizr/structurizr) |
| PlantUML MIT build | Code-level rendering using Smetana | [plantuml/plantuml](https://github.com/plantuml/plantuml) |
| MCP TypeScript SDK | MCP stdio server and clients | [modelcontextprotocol/typescript-sdk](https://github.com/modelcontextprotocol/typescript-sdk) |
| Zod | Architecture contract validation | [colinhacks/zod](https://github.com/colinhacks/zod) |
| Playwright | Headless native diagram rendering | [microsoft/playwright](https://github.com/microsoft/playwright) |
| Sharp | PNG rendering and alpha verification | [lovell/sharp](https://github.com/lovell/sharp) |

Structurizr and PlantUML engine binaries are downloaded by `npm run setup`,
not stored in this repository. The setup script selects the `plantuml-mit`
artifact. Inspect the licenses supplied with downloaded artifacts before
redistributing them or generated static viewers.

C4Loom is an independent project. It is not an official Structurizr or PlantUML
product and does not imply endorsement by those projects.
