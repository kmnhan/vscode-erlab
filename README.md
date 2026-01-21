# VS Code Extension for xarray Objects (with optional ERLab tools)

[![VS Code Marketplace Version](https://img.shields.io/visual-studio-marketplace/v/khan.erlab?label=marketplace)](https://marketplace.visualstudio.com/items?itemName=khan.erlab)
[![Open VSX Version](https://img.shields.io/open-vsx/v/khan/erlab)](https://open-vsx.org/extension/khan/erlab)

This extension adds a dedicated xarray Objects panel for Jupyter notebooks, plus hover
and context actions to inspect metadata for `DataArray`, `Dataset`, and `DataTree`
variables. It works with any kernel that has xarray, and optionally adds integration
with GUI tools when the [`erlab` package](https://github.com/kmnhan/erlabpy) is
available.

## Features

![Hover menu showing DataArray shape and actions](images/screenshot-hover.png)

When hovering over a variable name in a Python cell of a Jupyter notebook, if the
variable is an xarray object (`DataArray`, `Dataset`, or `DataTree`), the hover shows
its name and type, along with actions to:

- Open the object's detail panel with its HTML representation.
- Pin objects to keep them at the top of the list.

The detail panel can also be triggered from the Jupyter Variables view.

### Integration with [`erlab`](https://github.com/kmnhan/erlabpy)

If the kernel has the [`erlab` package](https://github.com/kmnhan/erlabpy) installed,
additional interactive tools appear for `DataArray` variables:

- Open the DataArray in an [ImageTool](https://erlabpy.readthedocs.io/en/stable/user-guide/interactive/imagetool.html).
- Watch/unwatch the DataArray to sync it with the [ImageTool Manager](https://erlabpy.readthedocs.io/en/stable/user-guide/interactive/manager.html).
- Access additional tools (ktool, dtool, restool, meshtool, ftool, goldtool) via the
  "More..." button.

## Usage

1. Open a Jupyter notebook with a Python kernel.
2. Open the xarray Objects view to browse variables.
3. Click an xarray object to open its detail panel and HTML representation.
4. Hover over a variable name in a Python cell to use quick actions.
5. Right-click a variable name to access actions from the context menu.

## Commands

- `erlab.openDetail` - Open the xarray Detail panel from the command palette or the
  Jupyter Variables view.

### `erlab` specific commands

These commands work on the currently selected variable in a Jupyter notebook cell, and
appear when the kernel has the `erlab` package installed:

- `erlab.watch` - Watch a DataArray (or show it if already watched).
- `erlab.unwatch` - Stop watching a DataArray.
- `erlab.itool` - Open the DataArray in the ImageTool.
- `erlab.ktool` - Open the DataArray in ktool (momentum conversion).
- `erlab.dtool` - Open the DataArray in dtool (visualizing dispersive features).
- `erlab.restool` - Open the DataArray in restool (fitting energy resolution).
- `erlab.meshtool` - Open the DataArray in meshtool.
- `erlab.ftool` - Open the DataArray in ftool (general curve fitting).
- `erlab.goldtool` - Open the DataArray in goldtool (Fermi edge fitting).
- `erlab.xarray.otherTools` - Show a picker to select from additional tools.

## Settings

- `erlab.xarray.displayExpandAttrs` (default: true) - Expand attributes section in
  xarray HTML representation.
- `erlab.xarray.displayExpandCoords` (default: true) - Expand coordinates section in
  xarray HTML representation.
- `erlab.xarray.displayExpandData` (default: false) - Expand data section in xarray HTML
  representation.
- `erlab.itool.useManager` (default: true) - Open in the ImageTool manager when it is
  already running. Otherwise, open in a new ImageTool window bound to the current
  kernel. If set to false, always open in the current kernel regardless of whether the
  manager is running.

## Requirements

- VS Code (or any compatible editor) with the Jupyter extension (`ms-toolsai.jupyter`)
  installed.
- A running Python kernel for the notebook, with `xarray >=2024.10` installed.
- (Optional) The [`erlab` Python package](https://github.com/kmnhan/erlabpy) for
  integration with its GUI. A Qt backend (PyQt6 or PySide6) is also required to use the
  GUI.

## Notes

- Hover and context actions run code in the active kernel. You may be prompted to allow
  code execution on first use.
