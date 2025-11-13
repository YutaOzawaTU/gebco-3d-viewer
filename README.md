# GEBCO 3D Viewer (Static Web App)

This repository contains a simple static web viewer that visualizes a GEBCO NetCDF tile (converted to JSON) as an interactive 3D terrain using Three.js.

Features:
- Load `data/gebco_tile.json` (lat, lon, elevation) and render a 3D terrain.
- X / Y / Z axis scale control (sliders and numeric inputs).
- Generate a rectangular base ("土台") with adjustable thickness for 3D printing.
- Download the current model (terrain + base) as an STL file.

## Usage

1. Unzip the repository and serve it as a static site (or push to GitHub and enable GitHub Pages).
2. Open `index.html` in a modern browser (Chrome, Firefox).
3. Use the controls on the right to adjust scales and base thickness, then click **STL ファイルをダウンロード** to save the STL.

## Notes

- The repository contains `data/gebco_tile.json` generated from the NetCDF file (if available).
- If you want to regenerate the JSON from a different `.nc` file, use a Python script similar to the one below:

```python
import xarray as xr
ds = xr.open_dataset("your.nc")
lat = ds['lat'].values
lon = ds['lon'].values
elev = ds['elevation'].values  # or the appropriate variable name
import json
json.dump({'lat':lat.tolist(), 'lon':lon.tolist(), 'elevation':elev.tolist()}, open('data/gebco_tile.json','w'))
```

## License
MIT
