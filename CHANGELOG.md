# Change Log

All notable changes to the extension will be documented in this file.

## [Unreleased]

- **Breaking**: Rename command namespace from `erlab.dataArray.*` to `erlab.xarray.*`
  and settings from `erlab.dataArray.*` to `erlab.xarray.*`.
- Add support for `xr.Dataset` and `xr.DataTree` in the xarray Objects panel, hover
  provider, and detail view.
- Rename "DataArrays" panel to "xarray Objects" and "DataArray Detail" to "xarray
  Detail".
- Dataset and DataTree objects can be pinned and inspected, but Watch and ImageTool
  features remain DataArray-only.
- Add "More..." button to DataArray hover menu with quick access to additional tools:
  `ktool`, `dtool`, `restool`, `meshtool`, `ftool`, and `goldtool`.
- Show persistent icons in the xarray tree view: an eye icon for watched DataArrays and
  type-specific icons for DataArray, Dataset, and DataTree.

## [v0.2.1] - 2026-01-13

- Add settings to configure DataArray HTML representation verbosity:
  `erlab.dataArray.displayExpandAttrs`, `erlab.dataArray.displayExpandCoords`, and
  `erlab.dataArray.displayExpandData`.
- Increase performance and reliability of DataArray detection in hover provider.
- Add logging to the extension output channel for easier debugging.

## [v0.2.0] - 2026-01-12

- Add DataArrays and DataArray Detail panels for browsing and inspecting DataArrays.
- Enrich hover actions to open details, pin, watch, and open ImageTool.

## [v0.1.0] - 2026-01-12

- Extend compatibility down to VS Code 1.99.0.
- Rename `erlab.manager` to `erlab.itool`.
- Add `erlab.itool.useManager` setting to control ImageTool manager usage.
- Show a notebook cell status bar button to open DataArray variables in ImageTool.

## [v0.0.2] - 2026-01-10

- Add an icon for the extension.
- Update packaging information in `package.json`.

## [v0.0.1] - 2026-01-10

- Initial release of the extension.
