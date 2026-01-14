# VS Code Extension for ERLabPy

[![VS Code Marketplace Version](https://img.shields.io/visual-studio-marketplace/v/khan.erlab?label=marketplace)](https://marketplace.visualstudio.com/items?itemName=khan.erlab)
[![Open VSX Version](https://img.shields.io/open-vsx/v/khan/erlab)](https://open-vsx.org/extension/khan/erlab)

This extension adds a panel which lists all `xarray.DataArray` variables in the active
Jupyter notebook, plus hover and context actions to inspect DataArray metadata and
trigger interactive features provided by [ERLabPy](https://github.com/kmnhan/erlabpy)
directly from Jupyter notebooks.

## Features

![Hover menu showing DataArray shape and actions](images/screenshot-hover.png)

When hovering over a variable name in a Python cell of a Jupyter notebook, if the
variable is an `xarray.DataArray`, the hover shows its name and dimensions, along with
actions to:

- Open the DataArray in an [ImageTool](https://erlabpy.readthedocs.io/en/stable/user-guide/interactive/imagetool.html).
- Watch/unwatch the DataArray to sync it with the [ImageTool Manager](https://erlabpy.readthedocs.io/en/stable/user-guide/interactive/manager.html).
- Open the DataArray detail panel with its HTML representation.
- Pin DataArrays to keep them at the top of the list.
- Access additional tools (ktool, dtool, restool, meshtool, ftool, goldtool) via the
  "More..." button.
- Use a per-cell status bar button to open a DataArray when the last line of a cell is a
  DataArray variable.

## Usage

1. Open a Jupyter notebook with a Python kernel.
2. Open the ERLab panel and use the DataArrays view to browse variables.
3. Click a DataArray to open its detail panel and HTML representation.
4. Hover over a variable name in a Python cell to use quick actions.
5. Right-click a variable name to access actions from the context menu.
6. When the last line of a cell is a DataArray variable name, use the status bar button
   under the cell to open it in ImageTool.

## Commands

All commands work on the currently selected variable in a Jupyter notebook cell unless
invoked from the DataArrays panel.

- `erlab.watch` - Watch a DataArray (or show it if already watched).
- `erlab.unwatch` - Stop watching a DataArray.
- `erlab.itool` - Open the DataArray in the ImageTool.
- `erlab.ktool` - Open the DataArray in ktool (momentum conversion).
- `erlab.dtool` - Open the DataArray in dtool (visualizing dispersive features).
- `erlab.restool` - Open the DataArray in restool (fitting energy resolution).
- `erlab.meshtool` - Open the DataArray in meshtool.
- `erlab.ftool` - Open the DataArray in ftool (general curve fitting).
- `erlab.goldtool` - Open the DataArray in goldtool (Fermi edge fitting).
- `erlab.dataArray.otherTools` - Show a picker to select from additional tools.

## Settings

- `erlab.itool.useManager` (default: true) - Open in the ImageTool manager when it is
  already running. Otherwise, open in a new ImageTool window bound to the current
  kernel. If set to false, always open in the current kernel regardless of whether the
  manager is running.
- `erlab.dataArray.displayExpandAttrs` (default: true) - Expand attributes section in
  DataArray HTML representation.
- `erlab.dataArray.displayExpandCoords` (default: true) - Expand coordinates section in
  DataArray HTML representation.
- `erlab.dataArray.displayExpandData` (default: false) - Expand data section in
  DataArray HTML representation.

## Requirements

- VS Code (or any compatible editor) with the Jupyter extension (`ms-toolsai.jupyter`)
  installed.
- A running Python kernel for the notebook.
- The [`erlab` Python package](https://github.com/kmnhan/erlabpy) must be installed in
  the kernel environment, along with a Qt backend (PyQt6 or PySide6) for the ImageTool.

## Notes

- Hover and context actions run code in the active kernel. You may be prompted to allow
  code execution on first use.
- The extension will not work if [`erlab`](https://github.com/kmnhan/erlabpy) is not
  installed.
