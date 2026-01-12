# VS Code Extension for ERLabPy

[![VS Code Marketplace Version](https://img.shields.io/visual-studio-marketplace/v/khan.erlab?label=marketplace)](https://marketplace.visualstudio.com/items?itemName=khan.erlab)
[![Open VSX Version](https://img.shields.io/open-vsx/v/khan/erlab)](https://open-vsx.org/extension/khan/erlab)

This extension adds a lightweight hover and context menu that let you inspect DataArray
shape info and trigger interactive features provided by
[ERLabPy](https://github.com/kmnhan/erlabpy) directly from Jupyter notebooks.

## Features

When hovering over a variable name in a Python cell of a Jupyter notebook, if the
variable is an `xarray.DataArray`, the hover shows its name and dimensions, along with
actions to:

- Watch/Show the DataArray in the ERLab ImageTool.
- Unwatch the DataArray.
- Open the DataArray in the ImageTool.
- Use a per-cell status bar button to open a DataArray when the last line of a cell is a
  DataArray variable.

## Usage

1. Open a Jupyter notebook with a Python kernel.
2. Hover over a variable name in a Python cell that is an `xarray.DataArray`.
3. You will see the hover with shape info and actions.
4. Alternatively, right-click the variable name to access the same actions from the
   context menu.
5. When the last line of a cell is a DataArray variable name, use the status bar button
   under the cell to open it in ImageTool.

## Commands

- `erlab.watch` - Watch a DataArray (or show it if already watched).
- `erlab.unwatch` - Stop watching a DataArray.
- `erlab.itool` - Open the DataArray in the ImageTool.

## Settings

- `erlab.itool.useManager` (default: true) - Open in the ImageTool manager when it is
  already running.

## Requirements

- VS Code (or any compatible editor) with the Jupyter extension (`ms-toolsai.jupyter`)
  installed.
- A running Python kernel for the notebook.
- The [`erlab` Python package](https://github.com/kmnhan/erlabpy) must be installed in
  the kernel environment.

## Notes

- Hover and context actions run code in the active kernel. You may be prompted to allow
  code execution on first use.
- The extension will not work if [`erlab`](https://github.com/kmnhan/erlabpy) is not
  installed.
