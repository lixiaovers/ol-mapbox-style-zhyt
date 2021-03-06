/*
ol-mapbox-style - Use Mapbox Style objects with OpenLayers
Copyright 2016-present ol-mapbox-style contributors
License: https://raw.githubusercontent.com/openlayers/ol-mapbox-style/master/LICENSE
*/

import mb2css from 'mapbox-to-css-font';
import applyStyleFunction, { getValue } from './stylefunction';
import googleFonts from 'webfont-matcher/lib/fonts/google';
import { fromLonLat } from 'ol-zhyt/proj';
import { createXYZ } from 'ol-zhyt/tilegrid';
import TileGrid from 'ol-zhyt/tilegrid/TileGrid';
import Map from 'ol-zhyt/Map';
import View from 'ol-zhyt/View';
import GeoJSON from 'ol-zhyt/format/GeoJSON';
import MVT from 'ol-zhyt/format/MVT';
import { unByKey } from 'ol-zhyt/Observable';
import TileLayer from 'ol-zhyt/layer/Tile';
import VectorLayer from 'ol-zhyt/layer/Vector';
import VectorTileLayer from 'ol-zhyt/layer/VectorTile';
import TileJSON from 'ol-zhyt/source/TileJSON';
import VectorSource from 'ol-zhyt/source/Vector';
import VectorTileSource from 'ol-zhyt/source/VectorTile';
import { Color } from '@mapbox/mapbox-gl-style-spec';
import { assign, defaultResolutions, initDefaultResolutions } from './util';
import { get as getProjection } from 'ol-zhyt/proj'
import MapEvent from 'ol-zhyt/MapEvent';

/**
 * @typedef {import("ol-zhyt/Map").default} PluggableMap
 * @typedef {import("ol-zhyt/layer/Layer").default} Layer
 * @typedef {import("ol-zhyt/source/Source").default} Source
 * @private
 */

const tilejsonCache = {};

const fontFamilyRegEx = /font-family: ?([^;]*);/;
const stripQuotesRegEx = /("|')/g;
let loadedFontFamilies;
function hasFontFamily(family) {
    if (!loadedFontFamilies) {
        loadedFontFamilies = {};
        const styleSheets = document.styleSheets;
        for (let i = 0, ii = styleSheets.length; i < ii; ++i) {
            const styleSheet = /** @type {CSSStyleSheet} */ (styleSheets[i]);
            try {
                const cssRules = styleSheet.rules || styleSheet.cssRules;
                if (cssRules) {
                    for (let j = 0, jj = cssRules.length; j < jj; ++j) {
                        const cssRule = cssRules[j];
                        if (cssRule.type == 5) {
                            const match = cssRule.cssText.match(fontFamilyRegEx);
                            loadedFontFamilies[match[1].replace(stripQuotesRegEx, '')] = true;
                        }
                    }
                }
            } catch (e) {
                // empty catch block
            }
        }
    }
    return family in loadedFontFamilies;
}

const processedFontFamilies = {};
const googleFamilies = googleFonts.getNames();

/**
 * @private
 * @param {Array} fonts Fonts.
 * @return {Array} Processed fonts.
 */
function getFonts(fonts) {
    const fontsKey = fonts.toString();
    if (fontsKey in processedFontFamilies) {
        return fonts;
    }
    const googleFontDescriptions = fonts.map(function (font) {
        const parts = mb2css(font, 1).split(' ');
        return [parts.slice(3).join(' ').replace(/"/g, ''), parts[1] + parts[0]];
    });
    for (let i = 0, ii = googleFontDescriptions.length; i < ii; ++i) {
        const googleFontDescription = googleFontDescriptions[i];
        const family = googleFontDescription[0];
        if (!hasFontFamily(family) && googleFamilies.indexOf(family) !== -1) {
            const fontUrl = 'https://fonts.googleapis.com/css?family=' + family.replace(/ /g, '+') + ':' + googleFontDescription[1];
            if (!document.querySelector('link[href="' + fontUrl + '"]')) {
                const markup = document.createElement('link');
                markup.href = fontUrl;
                markup.rel = 'stylesheet';
                document.head.appendChild(markup);
            }
        }
    }
    processedFontFamilies[fontsKey] = true;
    return fonts;
}

const spriteRegEx = /^(.*)(\?.*)$/;

function withPath(url, path) {
    if (path && url.indexOf('.') === 0) {
        url = path + url;
    }
    return url;
}

function toSpriteUrl(url, path, extension) {
    url = withPath(url, path);
    const parts = url.match(spriteRegEx);
    return parts ?
        parts[1] + extension + (parts.length > 2 ? parts[2] : '') :
        url + extension;
}

/**
 * ```js
 * import {applyStyle} from 'ol-mapbox-style';
 * ```
 *
 * Applies a style function to an `ol.layer.VectorTile` or `ol.layer.Vector`
 * with an `ol.source.VectorTile` or an `ol.source.Vector`. The style function
 * will render all layers from the `glStyle` object that use the specified
 * `source`, or a subset of layers from the same source. The source needs to be
 * a `"type": "vector"` or `"type": "geojson"` source.
 *
 * Two additional properties will be set on the provided layer:
 *
 *  * `mapbox-source`: The `id` of the Mapbox Style document's source that the
 *    OpenLayers layer was created from. Usually `apply()` creates one
 *    OpenLayers layer per Mapbox Style source, unless the layer stack has
 *    layers from different sources in between.
 *  * `mapbox-layers`: The `id`s of the Mapbox Style document's layers that are
 *    included in the OpenLayers layer.
 *
 * @param {VectorTileLayer|VectorLayer} layer OpenLayers layer.
 * @param {string|Object} glStyle Mapbox Style object.
 * @param {string|Array<string>} source `source` key or an array of layer `id`s from the
 * Mapbox Style object. When a `source` key is provided, all layers for the
 * specified source will be included in the style function. When layer `id`s
 * are provided, they must be from layers that use the same source.
 * @param {string} [path=undefined] Path of the style file. Only required when
 * a relative path is used with the `"sprite"` property of the style.
 * @param {Array<number>} [resolutions=undefined] Resolutions for mapping resolution to zoom level.
 * @param {ol-zhyt/Map} map 地图对象，供往外传递获取的精灵图信息. added by lipeng 2020.10.15
 * @return {Promise} Promise which will be resolved when the style can be used
 * for rendering.
 */
// export function applyStyle(layer, glStyle, source, path, resolutions) {
export function applyStyle(layer, glStyle, source, path, resolutions, map) {
    return new Promise(function (resolve, reject) {

        // TODO: figure out where best place to check source type is
        // Note that the source arg is an array of gl layer ids and each must be
        // dereferenced to get source type to validate
        if (typeof glStyle != 'object') {
            glStyle = JSON.parse(glStyle);
        }
        if (glStyle.version != 8) {
            return reject(new Error('glStyle version 8 required.'));
        }
        if (!(layer instanceof VectorLayer || layer instanceof VectorTileLayer)) {
            return reject(new Error('Can only apply to VectorLayer or VectorTileLayer'));
        }

        let spriteScale, spriteData, spriteImageUrl, style;
        function onChange() {
            if (!style && (!glStyle.sprite || spriteData)) {
                style = applyStyleFunction(layer, glStyle, source, resolutions, spriteData, spriteImageUrl, getFonts);
                if (!layer.getStyle()) {
                    reject(new Error(`Nothing to show for source [${source}]`));
                } else {
                    //将精灵图信息保存到map上，供开发者使用 added by lipeng 2020.10.15
                    if (!map._VectorTileInfo) {
                        map._VectorTileInfo = {}
                    }
                    map._VectorTileInfo.spriteData = spriteData;
                    map._VectorTileInfo.spriteImageUrl = spriteImageUrl;

                    resolve();
                }
            } else if (style) {
                //将精灵图信息保存到map上，供开发者使用 added by lipeng 2020.10.15
                if (!map._VectorTileInfo) {
                    map._VectorTileInfo = {}
                }
                map._VectorTileInfo.spriteData = spriteData;
                map._VectorTileInfo.spriteImageUrl = spriteImageUrl;

                layer.setStyle(style);
                resolve();
            } else {
                reject(new Error('Something went wrong trying to apply style.'));
            }
        }

        if (glStyle.sprite) {
            spriteScale = window.devicePixelRatio >= 1.5 ? 0.5 : 1;
            const sizeFactor = spriteScale == 0.5 ? '@2x' : '';
            let spriteUrl = toSpriteUrl(glStyle.sprite, path, sizeFactor + '.json');

            fetch(spriteUrl, { credentials: 'same-origin' })
                .then(function (response) {
                    if (!response.ok && (sizeFactor !== '')) {
                        spriteUrl = toSpriteUrl(glStyle.sprite, path, '.json');
                        return fetch(spriteUrl, { credentials: 'same-origin' });
                    } else {
                        return response;
                    }
                })
                .then(function (response) {
                    if (response.ok) {
                        return response.json();
                    } else {
                        reject(new Error(`Problem fetching sprite from ${spriteUrl}: ${response.statusText}`));
                    }
                })
                .then(function (spritesJson) {
                    if ((spritesJson === undefined) || (Object.keys(spritesJson).length === 0)) {
                        return reject(new Error('No sprites found.'));
                    }
                    spriteData = spritesJson;
                    spriteImageUrl = toSpriteUrl(glStyle.sprite, path, sizeFactor + '.png');
                    onChange();
                })
                .catch(function (err) {
                    reject(new Error(`Sprites cannot be loaded: ${spriteUrl}: ${err.message}`));
                });
        } else {
            onChange();
        }

    });
}

const emptyObj = {};

function setBackground(map, layer) {
    const background = {
        type: layer.type
    };
    function updateStyle() {
        const element = map.getTargetElement();
        if (!element) {
            return;
        }
        const layout = layer.layout || {};
        const paint = layer.paint || {};
        background['paint'] = paint;
        background.id = 'olms-bg-' + paint['background-opacity'] + paint['background-color'];
        const zoom = map.getView().getZoom();
        if (paint['background-color'] !== undefined) {
            const bg = getValue(background, 'paint', 'background-color', zoom, emptyObj);
            element.style.background = Color.parse(bg).toString();
        }
        if (paint['background-opacity'] !== undefined) {
            element.style.opacity = getValue(background, 'paint', 'background-opacity', zoom, emptyObj);
        }
        // if (layout.visibility == 'none') {
        //增加背景图层对minzoom、maxzoom的支持 added by lipeng 2020.9.24
        if (layout.visibility === 'none' || ('minzoom' in layer && zoom < layer.minzoom) ||
            ('maxzoom' in layer && zoom > layer.maxzoom)) {
            element.style.backgroundColor = '';
            element.style.opacity = '';
        }
    }

    /*
       if (map.getTargetElement()) {
           updateStyle();
       }
       map.on(['change:resolution', 'change:target'], updateStyle);
       */

    //modified by lipeng 2020.9.23
    //这里原作者可能写错了，map不支持change:resolution事件 
    //同时为targetElement添加属性事件，方便重设样式文件时解绑
    let targetEle = map.getTargetElement();
    if (targetEle) {
        updateStyle();

        if (targetEle.event_change_resolution) {
            map.getView().un('change:resolution', targetEle.event_change_resolution);
        }
    }

    targetEle.event_change_resolution = updateStyle;
    map.getView().on('change:resolution', updateStyle);
}

/**
 * ```js
 * import {applyBackground} from 'ol-mapbox-style';
 * ```
 * Applies properties of the Mapbox Style's first `background` layer to the map.
 * @param {PluggableMap} map OpenLayers Map.
 * @param {Object} glStyle Mapbox Style object.
 */
export function applyBackground(map, glStyle) {
    glStyle.layers.some(function (l) {
        if (l.type == 'background') {
            setBackground(map, l);
            return true;
        }
    });
}

function getSourceIdByRef(layers, ref) {
    let sourceId;
    layers.some(function (layer) {
        if (layer.id == ref) {
            sourceId = layer.source;
            return true;
        }
    });
    return sourceId;
}

function extentFromTileJSON(tileJSON) {
    const bounds = tileJSON.bounds;
    if (bounds) {
        const ll = fromLonLat([bounds[0], bounds[1]]);
        const tr = fromLonLat([bounds[2], bounds[3]]);
        return [ll[0], ll[1], tr[0], tr[1]];
    }
}

// function setupVectorLayer(glSource, accessToken, url) {
/**
 * 增加glLayers、map参数，用于定义MVT的过滤方法
 * @param {*} glSource
 * @param {string} glSourceId 数据源key，用于设置图层ID  added by lipeng 2020.9.23
 * @param {*} accessToken
 * @param {*} url
 * @param {Object} glLayers 样式文件的layers节点
 * @param {ol-zhyt/map} map
 */
function setupVectorLayer(glSource, glSourceId, accessToken, url, glLayers, map) {
    glSource = assign({}, glSource);

    //重置 added by lipeng 2020.9.17
    LayerZoomMap = {};

    //对应用更改的样式，使用之前已存在的图层 modified by lipeng 2020.9.23
    let counter = 1;
    if (VectorLayerCounter[glSourceId]) {
        counter = ++VectorLayerCounter[glSourceId];
    } else {
        VectorLayerCounter[glSourceId] = 1;
    }

    let layerId = [glSourceId, counter].join("_");
    let layer = getLayerByID(map, layerId);
    if (layer) {
        return layer;
    } else {
        layer = new VectorTileLayer({
            declutter: true,
            visible: false
        });

        layer.set("id", layerId);
        layer.set("isStyleCreated", true)
    }

    // const layer = new VectorTileLayer({
    //     declutter: true,
    //     visible: false
    // });
    const cacheKey = JSON.stringify(glSource);
    let tilejson = tilejsonCache[cacheKey];
    if (!tilejson) {
        tilejson = tilejsonCache[cacheKey] = new TileJSON({
            url: glSource.tiles ? undefined : url,
            tileJSON: glSource.tiles ? glSource : undefined
        });
    }
    const key = tilejson.on('change', function () {
        const state = tilejson.getState();
        if (state === 'ready') {
            const tileJSONDoc = tilejson.getTileJSON();
            const tiles = Array.isArray(tileJSONDoc.tiles) ? tileJSONDoc.tiles : [tileJSONDoc.tiles];
            if (glSource.url) {
                for (let i = 0, ii = tiles.length; i < ii; ++i) {
                    const tile = tiles[i];
                    if (tile.indexOf('http') != 0) {
                        tiles[i] = glSource.url.replace(/\/?$/, '/') + tile.replace(/^\//, '');
                    }
                }
            }
            const tileGrid = tilejson.getTileGrid();
            const extent = extentFromTileJSON(tileJSONDoc);
            const minZoom = tileJSONDoc.minzoom || 0;
            const maxZoom = tileJSONDoc.maxzoom || 22;
            let source = tilejson.get('ol-source');
            if (source === undefined) {
                /*
                source = new VectorTileSource({
                    attributions: tilejson.getAttributions(),
                    format: new MVT(),
                    tileGrid: new TileGrid({
                        origin: tileGrid.getOrigin(0),
                        extent: extent || tileGrid.getExtent(),
                        minZoom: minZoom,
                        resolutions: defaultResolutions.slice(0, maxZoom + 1),
                        tileSize: 512
                    }),
                    urls: tiles
                });
                */

                //自定义支持4490空间参考 added by lipeng 2020.9.1
                if (glSource.srs.indexOf("4490") > -1) {
                    initDefaultResolutions("EPSG:4490");
                    let proj4490 = getProjection("EPSG:4490");

                    let tileUrlFunction = undefined;
                    if (tiles.length == 1) {
                        tileUrlFunction = function (tileCoord) {
                            let url = tiles[0];
                            return url.replace("{z}", (tileCoord[0] - 1))
                                .replace("{x}", tileCoord[1])
                                .replace("{y}", ((1 << (tileCoord[0] - 1)) - tileCoord[2] - 1));
                        }
                    } else {
                        //FIXME 暂不支持多url的自定义行列号 by lipeng 2020.9.18
                    }

                    source = new VectorTileSource({
                        format: new MVT({
                            //使用过滤器控制只实例化可见图层的要素 added by lipeng 2020.9.16
                            filter: (function () {
                                return getMVTFilter(glLayers, map);
                            })()
                        }),
                        crossOrigin: "anonymous",
                        tileGrid: createXYZ({
                            extent: proj4490.getExtent(),
                            minZoom: minZoom,
                            maxZoom: maxZoom
                        }),
                        projection: proj4490,
                        tileUrlFunction: tileUrlFunction
                    })
                } else {//源码，默认3857 空间参考 by lipeng 2020.9.1 
                    initDefaultResolutions("EPSG:3857");
                    source = new VectorTileSource({
                        attributions: tilejson.getAttributions(),
                        format: new MVT({
                            //使用过滤器控制只实例化可见图层的要素 added by lipeng 2020.9.16
                            filter: (function () {
                                return getMVTFilter(glLayers, map);
                            })()
                        }),
                        tileGrid: new TileGrid({
                            origin: tileGrid.getOrigin(0),
                            extent: extent || tileGrid.getExtent(),
                            minZoom: minZoom,
                            resolutions: defaultResolutions.slice(0, maxZoom + 1),
                            tileSize: 512
                        }),
                        urls: tiles
                    });
                }
                tilejson.set('ol-source', source);
            }
            unByKey(key);
            layer.setSource(source);
        } else if (state === 'error') {
            tilejson.set('ol-source', null);
            unByKey(key);
            layer.setSource(undefined);
        }
    });
    if (tilejson.getState() === 'ready') {
        tilejson.changed();
    }
    return layer;
}

/**
 * 记录style文件的layers节点中，各图层在特定zoom下是否可见
 */
var LayerZoomMap = {};
/**
 * 根据样式文件定义的图层可见级别，过滤图层中MVT.readFeatures的要素实例化
 * 避免默认所有图层所有要素都实例化导致的内存过高甚至溢出问题
 * added by lipeng 2020.9.16
 * @param {Ojbect} glLayers mapbox样式文件中的layers节点
 * @param {ol.map} map 
 */
function getMVTFilter(glLayers, map) {
    return function (rawFeature) {
        let lyrName = rawFeature.layer.name,
            zoom = Math.round(map.getView().getZoom());

        if (!LayerZoomMap[zoom]) {
            LayerZoomMap[zoom] = {}
        }

        let layerZoom = LayerZoomMap[zoom][lyrName];

        if (typeof layerZoom !== "undefined") {
            return layerZoom;
        } else {
            layerZoom = LayerZoomMap[zoom][lyrName] = false;
        }

        let srcLyrName = void 0,
            isAddLayerFeature = false,
            minZoom,
            maxZoom;
        for (const key in glLayers) {
            const glLayer = glLayers[key];
            srcLyrName = glLayer["source-layer"];
            if (srcLyrName !== lyrName) {
                continue;
            }

            if (!glLayer.layout || glLayer.layout.visibility !== "none") {
                minZoom = 'minzoom' in glLayer ? glLayer.minzoom : 0;
                maxZoom = 'maxzoom' in glLayer ? glLayer.maxzoom : 24;

                isAddLayerFeature = (zoom >= minZoom && zoom <= maxZoom);

                if (isAddLayerFeature) break;
            }
        }
        return layerZoom = LayerZoomMap[zoom][lyrName] = isAddLayerFeature;
    }
}

function setupRasterLayer(glSource, url) {
    const layer = new TileLayer();
    // const source = new TileJSON({
    //     transition: 0,
    //     url: glSource.tiles ? undefined : url,
    //     tileJSON: glSource.tiles ? glSource : undefined,
    //     crossOrigin: 'anonymous'
    // });

    //使raster图层支持其他空间参考，如：4490等 added by lipeng 2020.9.21
    let proj = getProjection("EPSG:3857");
    if (glSource.srs.indexOf("4490") > -1) {
        initDefaultResolutions("EPSG:4490");
        proj = getProjection("EPSG:4490");
    }

    var source = new TileJSON({
        transition: 0,
        url: glSource.tiles ? undefined : url,
        tileJSON: glSource.tiles ? glSource : undefined,
        crossOrigin: 'anonymous',
        projection: proj  // added by lipeng 2020.9.21
    });

    const key = source.on('change', function () {
        const state = source.getState();
        if (state === 'ready') {
            unByKey(key);

            //对非3857空间参考，不使用下面重建TileGrid的代码 modified by lipeng 2020.9.21
            if (glSource.srs.indexOf("3857") > -1) {
                const tileJSONDoc = /** @type {Object} */ (source.getTileJSON());
                const extent = extentFromTileJSON(tileJSONDoc);
                const tileGrid = source.getTileGrid();
                const tileSize = glSource.tileSize || tileJSONDoc.tileSize || 512;
                const minZoom = tileJSONDoc.minzoom || 0;
                const maxZoom = tileJSONDoc.maxzoom || 22;
                // Only works when using ES modules
                source.tileGrid = new TileGrid({
                    origin: tileGrid.getOrigin(0),
                    extent: extent || tileGrid.getExtent(),
                    minZoom: minZoom,
                    resolutions: createXYZ({
                        maxZoom: maxZoom,
                        tileSize: tileSize
                    }).getResolutions(),
                    tileSize: tileSize
                });
            }
            layer.setSource(source);
        } else if (state === 'error') {
            unByKey(key);
            layer.setSource(undefined);
        }
    });
    source.setTileLoadFunction(function (tile, src) {
        if (src.indexOf('{bbox-epsg-3857}') != -1) {
            const bbox = source.getTileGrid().getTileCoordExtent(tile.getTileCoord());
            src = src.replace('{bbox-epsg-3857}', bbox.toString());
        }
        const img = /** @type {import("ol-zhyt/ImageTile").default} */ (tile).getImage();
    /** @type {HTMLImageElement} */ (img).src = src;
    });
    return layer;
}

const geoJsonFormat = new GeoJSON();
// function setupGeoJSONLayer(glSource, path) { modified by lipeng 2020.9.23
function setupGeoJSONLayer(glSource, glSourceId, path, map) {
    const data = glSource.data;
    let features, geoJsonUrl;

    //对应用更改的样式，使用之前已存在的图层 modified by lipeng 2020.9.23
    let counter = 1;
    if (VectorLayerCounter[glSourceId]) {
        counter = ++VectorLayerCounter[glSourceId];
    } else {
        VectorLayerCounter[glSourceId] = 1;
    }

    let layerId = [glSourceId, counter].join("_");
    var layer = getLayerByID(map, layerId);
    if (layer) {
        return layer;
    }

    if (typeof data == 'string') {
        geoJsonUrl = withPath(data, path);
    } else {
        // features = geoJsonFormat.readFeatures(data, { featureProjection: 'EPSG:3857' });

        //使geojson支持3857外的其他空间参考 modified by lipeng 2020.9.21
        let srs = glSource.srs || "EPSG:3857";
        features = geoJsonFormat.readFeatures(data, { featureProjection: srs });
    }
    return new VectorLayer({
        source: new VectorSource({
            attributions: glSource.attribution,
            features: features,
            format: geoJsonFormat,
            url: geoJsonUrl
        }),
        visible: false
    });
}

function updateRasterLayerProperties(glLayer, layer, view) {
    const zoom = view.getZoom();
    const opacity = getValue(glLayer, 'paint', 'raster-opacity', zoom, emptyObj);
    layer.setOpacity(opacity);
}

//矢量图层计数器，并保存了矢量图层的数组，用于应用修改后样式时，重用/删除废弃图层
//added by lipeng 2020.9.23
let VectorLayerCounter = {
    layers: []
}

function processStyle(glStyle, map, baseUrl, host, path, accessToken) {
    //触发自定义mapbox-style-applied事件，并将style存储在事件对象中 added by lipeng 2020.9.11
    map.dispatchEvent(new MapEvent("mapbox-style-applied", map, glStyle));

    //初始化矢量图层计数器 added by lipeng 2020.9.23
    VectorLayerCounter = {
        layers: []
    }

    const promises = [];
    let view = map.getView();
    if (!view.isDef() && !view.getRotation() && !view.getResolutions()) {
        view = new View({
            maxResolution: defaultResolutions[0]
        });
        map.setView(view);
    }

    if ('center' in glStyle && !view.getCenter()) {
        view.setCenter(fromLonLat(glStyle.center));
    }
    if ('zoom' in glStyle && view.getZoom() === undefined) {
        view.setResolution(defaultResolutions[0] / Math.pow(2, glStyle.zoom));
    }
    if (!view.getCenter() || view.getZoom() === undefined) {
        view.fit(view.getProjection().getExtent(), {
            nearest: true,
            size: map.getSize()
        });
    }
    if (glStyle.sprite) {
        if (glStyle.sprite.indexOf('mapbox://') == 0) {
            glStyle.sprite = baseUrl + '/sprite' + accessToken;
        } else if (glStyle.sprite.indexOf('http') != 0) {
            glStyle.sprite = (host ? (host + path) : '') + glStyle.sprite + accessToken;
        }
    }

    const glLayers = glStyle.layers;

    //修改样式json时，删除不存在图层 modified by lipeng 2020.9.23
    removeUnExistLayer(map, glLayers);

    let layerIds = [];

    let glLayer, glSource, glSourceId, id, layer, url;
    for (let i = 0, ii = glLayers.length; i < ii; ++i) {
        glLayer = glLayers[i];
        const type = glLayer.type;
        if (type == 'heatmap' || type == 'hillshade') {
            //FIXME Unsupported layer type
        } else if (type == 'background') {
            setBackground(map, glLayer);
        } else {
            id = glLayer.source || getSourceIdByRef(glLayers, glLayer.ref);
            // this technique assumes gl layers will be in a particular order
            if (id != glSourceId) {
                if (layerIds.length) {
                    promises.push(finalizeLayer(layer, layerIds, glStyle, path, map));
                    layerIds = [];
                }
                glSource = glStyle.sources[id];
                url = glSource.url;
                if (url) {
                    url = withPath(url, path);
                    if (url.indexOf('mapbox://') == 0) {
                        const mapid = url.replace('mapbox://', '');
                        glSource.tiles = ['a', 'b', 'c', 'd'].map(function (host) {
                            return 'https://' + host + '.tiles.mapbox.com/v4/' + mapid +
                                '/{z}/{x}/{y}.' +
                                (glSource.type == 'vector' ? 'vector.pbf' : 'png') +
                                accessToken;
                        });
                    }
                }


                if (glSource.type == 'vector') {
                    // layer = setupVectorLayer(glSource, accessToken, url);
                    //增加数据源key作为参数  modified by lipeng 2020.9.23
                    layer = setupVectorLayer(glSource, id, accessToken, url, glStyle.layers, map);
                } else if (glSource.type == 'raster') {
                    // layer = setupRasterLayer(glSource, url);

                    //对已存在、初始创建两种情况分别设置 modified by lipeng 2020.9.23
                    layer = getLayerByID(map, glLayer.id);
                    if (!layer) {
                        layer = setupRasterLayer(glSource, url);
                        layer.set("id", glLayer.id);
                        layer.set('isStyleCreated', true);
                    } else {
                        view.un('change:resolution', layer.get("event_change_resolution"));
                    }

                    layer.setVisible(glLayer.layout ? glLayer.layout.visibility !== 'none' : true);

                    // view.on('change:resolution', updateRasterLayerProperties.bind(this, glLayer, layer, view));

                    //将事件回调保存在layer属性中，方便下次应用修改样式时解绑 modified by lipeng 2020.9.23
                    let callback = updateRasterLayerProperties.bind(this, glLayer, layer, view);
                    layer.set('event_change_resolution', callback);
                    view.on('change:resolution', callback);

                    updateRasterLayerProperties(glLayer, layer, view);
                } else if (glSource.type == 'geojson') {
                    // layer = setupGeoJSONLayer(glSource, path); 
                    //modified by lipeng 2020.9.23
                    layer = setupGeoJSONLayer(glSource, id, path, map);
                }
                glSourceId = id;
                if (layer) {
                    layer.set('mapbox-source', glSourceId);
                }
            }
            layerIds.push(glLayer.id);
        }
    }
    promises.push(finalizeLayer(layer, layerIds, glStyle, path, map));
    map.set('mapbox-style', glStyle);
    return Promise.all(promises);
}

/**
 * @description 从地图中删除已经不存在于glLayers中的图层
 * @param {ol.Map} map 
 * @param {Array} glLayers 
 * @author lipeng
 * @since 2020.9.23
 */
function removeUnExistLayer(map, glLayers) {
    let layers = map.getLayers(),
        idTemp = void 0,
        isStyleCreated = false,
        isExist = false,
        layerTemp = void 0;
    for (let i = 0; i < layers.length; i++) {
        layerTemp = layers[i];
        idTemp = layerTemp.get("id");
        isStyleCreated = layerTemp.get('isStyleCreated');
        if (isStyleCreated === false || !idTemp) {
            continue;
        }

        isExist = false;

        for (let j = 0; j < glLayers.length; j++) {
            const glLayer = glLayers[j];
            if (idTemp === glLayer.id) {
                isExist = true;
            }
        }

        if (!isExist) {
            if (layerTemp instanceof TileLayer) {
                map.getView().un('change:resolution', layerTemp.get("event_change_resolution"));
            }
            map.removeLayer(layerTemp);
        }
    }
}

/**
 * @description 根据样式文件中图层id获取map中已创建的图层
 * @param {ol.Map} map 
 * @param {string} layerID 
 * @author lipeng
 * @since 2020.9.23
 */
function getLayerByID(map, layerID) {
    let layers = map.getLayers().getArray();
    for (let i = 0, len = layers.length; i < len; i++) {
        if (layers[i].get("id") === layerID && layers[i].get("isStyleCreated")) {
            return layers[i];
        }
    }
}

/**
 * ```js
 * import olms from 'ol-mapbox-style';
 * ```
 *
 * Loads and applies a Mapbox Style object to an OpenLayers Map. This includes
 * the map background, the layers, the center and the zoom.
 *
 * The center and zoom will only be set if present in the Mapbox Style document,
 * and if not already set on the OpenLayers map.
 *
 * Layers will be added to the OpenLayers map, without affecting any layers that
 * might already be set on the map.
 *
 * Layers added by `apply()` will have two additional properties:
 *
 *  * `mapbox-source`: The `id` of the Mapbox Style document's source that the
 *    OpenLayers layer was created from. Usually `apply()` creates one
 *    OpenLayers layer per Mapbox Style source, unless the layer stack has
 *    layers from different sources in between.
 *  * `mapbox-layers`: The `id`s of the Mapbox Style document's layers that are
 *    included in the OpenLayers layer.
 *
 * This function sets an additional `mapbox-style` property on the OpenLayers
 * map instance, which holds the Mapbox Style object.
 *
 * @param {PluggableMap|HTMLElement|string} map Either an existing OpenLayers Map
 * instance, or a HTML element, or the id of a HTML element that will be the
 * target of a new OpenLayers Map.
 * @param {string|Object} style JSON style object or style url pointing to a
 * Mapbox Style object. When using Mapbox APIs, the url must contain an access
 * token and look like
 * `https://api.mapbox.com/styles/v1/mapbox/bright-v9?access_token=[your_access_token_here]`.
 * When passed as JSON style object, all OpenLayers layers created by `apply()`
 * will be immediately available, but they may not have a source yet (i.e. when
 * they are defined by a TileJSON url in the Mapbox Style document). When passed
 * as style url, layers will be added to the map when the Mapbox Style document
 * is loaded and parsed.
 * @return {Promise} A promise that resolves after all layers have been added to
 * the OpenLayers Map instance, their sources set, and their styles applied. the
 * `resolve` callback will be called with the OpenLayers Map instance as
 * argument.
 */
export default function olms(map, style) {

    let accessToken, baseUrl, host, path, promise;
    accessToken = baseUrl = host = path = '';

    if (typeof map === 'string' || map instanceof HTMLElement) {
        map = new Map({
            target: map
        });
    }

    if (typeof style === 'string') {
        const parts = style.match(spriteRegEx);
        if (parts) {
            baseUrl = parts[1];
            accessToken = parts.length > 2 ? parts[2] : '';
        }
        promise = new Promise(function (resolve, reject) {
            fetch(style, {
                credentials: 'same-origin'
            })
                .then(function (response) {
                    return response.json();
                })
                .then(function (glStyle) {
                    const a = /** @type {HTMLAnchorElement} */ (document.createElement('A'));
                    a.href = style;
                    const href = a.href;
                    path = a.pathname.split('/').slice(0, -1).join('/') + '/';
                    host = href.substr(0, href.indexOf(path));

                    processStyle(glStyle, map, baseUrl, host, path, accessToken)
                        .then(function () {
                            resolve(map);
                        })
                        .catch(reject);
                })
                .catch(function (err) {
                    reject(new Error(`Could not load ${style}: ${err.message}`));
                });
        });
    } else {
        promise = new Promise(function (resolve, reject) {
            processStyle(style, map)
                .then(function () {
                    resolve(map);
                })
                .catch(reject);
        });
    }

    return promise;
}

/**
 * ```js
 * import {apply} from 'ol-mapbox-style';
 * ```
 * Like `olms`, but returns an `ol-zhyt/Map` instance instead of a `Promise`.
 *
 * @param {PluggableMap|HTMLElement|string} map Either an existing OpenLayers Map
 * instance, or a HTML element, or the id of a HTML element that will be the
 * target of a new OpenLayers Map.
 * @param {string|Object} style JSON style object or style url pointing to a
 * Mapbox Style object. When using Mapbox APIs, the url must contain an access
 * token and look like
 * `https://api.mapbox.com/styles/v1/mapbox/bright-v9?access_token=[your_access_token_here]`.
 * When passed as JSON style object, all OpenLayers layers created by `apply()`
 * will be immediately available, but they may not have a source yet (i.e. when
 * they are defined by a TileJSON url in the Mapbox Style document). When passed
 * as style url, layers will be added to the map when the Mapbox Style document
 * is loaded and parsed.
 * @return {PluggableMap} The OpenLayers Map instance that will be populated with the
 * contents described in the Mapbox Style object.
 */
export function apply(map, style) {
    if (typeof map === 'string' || map instanceof HTMLElement) {
        map = new Map({
            target: map
        });
    }
    setTimeout(function () {
        olms(map, style);
    }, 0);
    return map;
}


/**
 * @private
 * If layerIds is not empty, applies the style specified in glStyle to the layer,
 * and adds the layer to the map.
 *
 * The layer may not yet have a source when the function is called.  If so, the style
 * is applied to the layer via a once listener on the 'change:source' event.
 *
 * @param {Layer} layer An OpenLayers layer instance.
 * @param {Array<string>} layerIds Array containing layer ids of already-processed layers.
 * @param {Object} glStyle Style as a JSON object.
 * @param {string|undefined} path The path part of the style URL. Only required
 * when a relative path is used with the `"sprite"` property of the style.
 * @param {PluggableMap} map OpenLayers Map.
 * @return {Promise} Returns a promise that resolves after the source has
 * been set on the specified layer, and the style has been applied.
 */
function finalizeLayer(layer, layerIds, glStyle, path, map) {
    let minZoom = 24;
    let maxZoom = 0;
    const glLayers = glStyle.layers;
    for (let i = 0, ii = glLayers.length; i < ii; ++i) {
        const glLayer = glLayers[i];
        if (layerIds.indexOf(glLayer.id) !== -1) {
            minZoom = Math.min('minzoom' in glLayer ? glLayer.minzoom : 0, minZoom);
            maxZoom = Math.max('maxzoom' in glLayer ? glLayer.maxzoom : 24, maxZoom);
        }
    }
    return new Promise(function (resolve, reject) {
        const setStyle = function () {
            const source = layer.getSource();
            if (!source || source.getState() === 'error') {
                reject(new Error('Error accessing data for source ' + layer.get('mapbox-source')));
                return;
            }
            if (typeof source.getTileGrid === 'function') {
                const tileGrid = source.getTileGrid();
                if (tileGrid) {
                    const sourceMinZoom = tileGrid.getMinZoom();
                    if (minZoom > 0 || sourceMinZoom > 0) {
                        layer.setMaxResolution(Math.min(defaultResolutions[minZoom], tileGrid.getResolution(sourceMinZoom)) + 1e-9);
                    }
                    if (maxZoom < 24) {
                        layer.setMinResolution(defaultResolutions[maxZoom] + 1e-9);
                    }
                }
            }
            if (source instanceof VectorSource || source instanceof VectorTileSource) {
                // applyStyle(/** @type {import("ol-zhyt/layer/Vector").default|import("ol-zhyt/layer/VectorTile").default} */(layer), glStyle, layerIds, path).then(function () {
                //增加map参数 modified by lipeng 2020.10.15
                applyStyle(/** @type {import("ol-zhyt/layer/Vector").default|import("ol-zhyt/layer/VectorTile").default} */(layer), glStyle, layerIds, path, undefined, map).then(function () {
                    layer.setVisible(true);
                    resolve();
                }, function (e) {
                    reject(e);
                });
            } else {
                resolve();
            }
        };

        layer.set('mapbox-layers', layerIds);
        if (map.getLayers().getArray().indexOf(layer) === -1) {
            map.addLayer(layer);
        }

        if (layer.getSource()) {
            setStyle();
        } else {
            layer.once('change:source', setStyle);
        }
    });
}


/**
 * ```js
 * import {getLayer} from 'ol-mapbox-style';
 * ```
 * Get the OpenLayers layer instance that contains the provided Mapbox Style
 * `layer`. Note that multiple Mapbox Style layers are combined in a single
 * OpenLayers layer instance when they use the same Mapbox Style `source`.
 * @param {PluggableMap} map OpenLayers Map.
 * @param {string} layerId Mapbox Style layer id.
 * @return {Layer} OpenLayers layer instance.
 */
export function getLayer(map, layerId) {
    const layers = map.getLayers().getArray();
    for (let i = 0, ii = layers.length; i < ii; ++i) {
        const mapboxLayers = layers[i].get('mapbox-layers');
        if (mapboxLayers && mapboxLayers.indexOf(layerId) !== -1) {
            return /** @type {Layer} */ (layers[i]);
        }
    }
}

/**
 * ```js
 * import {getLayers} from 'ol-mapbox-style';
 * ```
 * Get the OpenLayers layer instances for the provided Mapbox Style `source`.
 * @param {PluggableMap} map OpenLayers Map.
 * @param {string} sourceId Mapbox Style source id.
 * @return {Array<Layer>} OpenLayers layer instances.
 */
export function getLayers(map, sourceId) {
    const result = [];
    const layers = map.getLayers().getArray();
    for (let i = 0, ii = layers.length; i < ii; ++i) {
        if (layers[i].get('mapbox-source') === sourceId) {
            result.push(/** @type {Layer} */(layers[i]));
        }
    }
    return result;
}

/**
 * ```js
 * import {getSource} from 'ol-mapbox-style';
 * ```
 * Get the OpenLayers source instance for the provided Mapbox Style `source`.
 * @param {PluggableMap} map OpenLayers Map.
 * @param {string} sourceId Mapbox Style source id.
 * @return {Source} OpenLayers source instance.
 */
export function getSource(map, sourceId) {
    const layers = map.getLayers().getArray();
    for (let i = 0, ii = layers.length; i < ii; ++i) {
        const source = /** @type {Layer} */ (layers[i]).getSource();
        if (layers[i].get('mapbox-source') === sourceId) {
            return source;
        }
    }
}

export {
    finalizeLayer as _finalizeLayer,
    getFonts as _getFonts
};
