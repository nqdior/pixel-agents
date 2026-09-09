# Four-room studio example

`studio.json` is an optional, generic office: three six-seat workrooms and a
shared lounge connected by walkable corridors. It uses bundled Pixel Agents
furniture and includes no personal folder names, pets, session IDs or credentials.

## Import and customize

1. In the office, use **Settings > Export Layout** to save your current design.
2. Use **Settings > Import Layout** and select `studio.json` from this directory.
3. Open **Layout > Areas**, select a room and use **Add folder...** to assign
   your project folders. Save the layout when finished.
4. Enable **Settings > Show Areas** if you want room labels visible.

`folder-mappings.example.json` illustrates the folder-name-to-Area mapping shape.
Its `tools`, `frontend` and `backend` names are examples, not automatic discovery
rules. The file is not installed automatically. Map your own folders through the
UI in each adapter (browser and VS Code keep separate settings).

This example is not the default office and never overwrites a saved layout on
startup. It can be regenerated from the repository root with:

```sh
npx tsx scripts/generate-studio-example.ts
```

The generator is deterministic and does not read your home directory or current
office. For local variants, pass room labels/pets to `createStudioLayout` in
`scripts/studio-example.ts` from an ignored script under `local/`.

## Credits

The corridor/room concept references **Four Rooms**, and the color zoning
references **Blue Office**, by pablodelucca in
[Pixel Index](https://github.com/pixel-agents-hq/index/tree/main/seed).
This is a new arrangement using the existing
[Pixel Agents](https://github.com/pixel-agents-hq/pixel-agents) assets, not an
imported community layout or additional third-party asset pack.
