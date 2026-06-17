<<<<<<< HEAD
const AMAP_DISTRICT_ENDPOINT = 'https://restapi.amap.com/v3/config/district';
const CHINA_ADCODE = '100000';
const R2_BINDING_NAME = 'AMAP_GEOJSON_BUCKET';
const R2_GEOJSON_KEY = 'amap/china-geojson.json';
const R2_META_KEY = 'amap/china-geojson-meta.json';
const R2_SOUTH_CHINA_SEA_LINES_KEY = 'amap/south-china-sea-ten-dash-lines.json';
const R2_SOUTH_CHINA_SEA_LINES_META_KEY = 'amap/south-china-sea-ten-dash-lines-meta.json';
const SOUTH_CHINA_SEA_LINES_SCHEMA_VERSION = 2;
const SANSHA_ADCODE = '460300';
=======
const ALIYUN_CHINA_FULL_GEOJSON_URL = 'https://geo.datav.aliyun.com/areas_v3/bound/100000_full.json';
const R2_BINDING_NAMES = ['ALIYUN_GEOJSON_BUCKET', 'AMAP_GEOJSON_BUCKET'];
const R2_GEOJSON_KEY = 'aliyun/china-geojson.json';
const R2_META_KEY = 'aliyun/china-geojson-meta.json';
const R2_TEN_DASH_KEY = 'aliyun/south-china-sea-ten-dash-line.json';
const R2_TEN_DASH_META_KEY = 'aliyun/south-china-sea-ten-dash-line-meta.json';
const SCHEMA_VERSION = 1;
>>>>>>> deb3aac (Switch to Aliyun GeoJson API)
const SOURCE_REFRESH_INTERVAL_SECONDS = 60 * 60 * 24;
const REFRESH_ERROR_BACKOFF_SECONDS = 60 * 60;
const EDGE_CACHE_SECONDS = 60 * 60;
const BROWSER_CACHE_SECONDS = 60 * 5;
const SOUTH_CHINA_SEA_FILTER_BOUNDS = {
  minLng:105,
  maxLng:127,
  minLat:3,
  maxLat:27
};

export async function onRequest(context){
  if(context.request.method !== 'GET'){
    return json({error:'Method Not Allowed'}, 405, {Allow:'GET'});
  }

<<<<<<< HEAD
  const cacheKey = new Request(new URL(context.request.url).origin + '/api/amap/china-geojson?v=4');
=======
  const cacheKey = new Request(new URL(context.request.url).origin + '/api/amap/china-geojson?source=aliyun-datav&v=1');
>>>>>>> deb3aac (Switch to Aliyun GeoJson API)
  const cache = typeof caches !== 'undefined' ? caches.default : null;

  try{
    const cached = cache ? await cache.match(cacheKey) : null;
    if(cached) return cached;

    const bucket = getBoundR2Bucket(context.env);
    const result = bucket
      ? await getGeoJsonWithR2Cache(bucket)
      : {
        geoJson:await refreshChinaGeoJson(),
        cacheStatus:'edge-only'
      };

    const response = json(result.geoJson, 200, cacheHeaders({
      'X-Map-Source':'aliyun-datav',
      'X-Map-Cache':result.cacheStatus
    }));
    if(cache) context.waitUntil(cache.put(cacheKey, response.clone()));
    return response;
  }catch(err){
    return json({error:err.message || 'Failed to load Aliyun DataV GeoJSON'}, 502, {
      'Cache-Control':'no-store'
    });
  }
}

async function getGeoJsonWithR2Cache(bucket){
  const [cachedGeoJson, meta, cachedTenDash] = await Promise.all([
    readR2Json(bucket, R2_GEOJSON_KEY),
    readR2Json(bucket, R2_META_KEY),
    readR2Json(bucket, R2_TEN_DASH_KEY)
  ]);

<<<<<<< HEAD
  const needsSouthChinaSeaLines = !hasSouthChinaSeaLinesPayload(cachedGeoJson);

  if(cachedGeoJson && !needsSouthChinaSeaLines && isFresh(meta?.checkedAt, SOURCE_REFRESH_INTERVAL_SECONDS)){
    return {geoJson:cachedGeoJson, cacheStatus:'r2-hit'};
  }

  if(cachedGeoJson && !needsSouthChinaSeaLines && isFresh(meta?.nextRetryAt, 0)){
=======
  const cacheUsable = cachedGeoJson?.schemaVersion === SCHEMA_VERSION;
  const tenDashMissing = cacheUsable &&
    !cachedTenDash &&
    cachedGeoJson.southChinaSeaTenDashLine?.features?.length;
  if(cacheUsable && isFresh(meta?.checkedAt, SOURCE_REFRESH_INTERVAL_SECONDS)){
    if(tenDashMissing){
      const now = new Date().toISOString();
      await writeTenDash(bucket, cachedGeoJson.southChinaSeaTenDashLine, {
        sourceHash:meta?.sourceHash || null,
        checkedAt:now,
        storedAt:now,
        restoredFromMainCache:true
      });
    }
    return {geoJson:cachedGeoJson, cacheStatus:'r2-hit'};
  }

  if(cacheUsable && isFresh(meta?.nextRetryAt, 0)){
>>>>>>> deb3aac (Switch to Aliyun GeoJson API)
    return {geoJson:cachedGeoJson, cacheStatus:'r2-stale-backoff'};
  }

  try{
    const nextGeoJson = await refreshChinaGeoJson();
    const sourceHash = await hashGeoJsonSource(nextGeoJson);
    const now = new Date().toISOString();

    if(cacheUsable && meta?.sourceHash === sourceHash){
      await writeMainMeta(bucket, {
        ...meta,
        schemaVersion:SCHEMA_VERSION,
        checkedAt:now,
        lastUnchangedAt:now,
        southChinaSeaLinesSchemaVersion:SOUTH_CHINA_SEA_LINES_SCHEMA_VERSION,
        nextRetryAt:null,
        lastError:null,
        refreshIntervalSeconds:SOURCE_REFRESH_INTERVAL_SECONDS
      });
<<<<<<< HEAD
      await writeSouthChinaSeaLinesMeta(bucket, cachedGeoJson.southChinaSeaLines, {
        sourceHash,
        checkedAt:now,
        storedAt:meta?.southChinaSeaLinesStoredAt || meta?.storedAt || now,
        unchanged:true
      });
=======
      if(tenDashMissing){
        await writeTenDash(bucket, cachedGeoJson.southChinaSeaTenDashLine, {
          sourceHash,
          checkedAt:now,
          storedAt:now,
          restoredFromMainCache:true
        });
      }else{
        await writeTenDashMeta(bucket, cachedGeoJson.southChinaSeaTenDashLine, {
          sourceHash,
          checkedAt:now,
          storedAt:meta?.tenDashStoredAt || meta?.storedAt || now,
          unchanged:true
        });
      }
>>>>>>> deb3aac (Switch to Aliyun GeoJson API)
      return {geoJson:cachedGeoJson, cacheStatus:'r2-revalidated-unchanged'};
    }

    await bucket.put(R2_GEOJSON_KEY, JSON.stringify(nextGeoJson), {
      httpMetadata:{contentType:'application/json; charset=utf-8'}
    });
<<<<<<< HEAD
    await writeSouthChinaSeaLines(bucket, nextGeoJson.southChinaSeaLines, {
      sourceHash,
      checkedAt:now,
      storedAt:now,
      unchanged:false
    });
    await writeR2Meta(bucket, {
      sourceHash,
      checkedAt:now,
      storedAt:now,
      southChinaSeaLinesStoredAt:now,
      southChinaSeaLinesSchemaVersion:SOUTH_CHINA_SEA_LINES_SCHEMA_VERSION,
      generatedAt:nextGeoJson.generatedAt,
      featureCount:nextGeoJson.features?.length || 0,
      southChinaSeaLineCount:nextGeoJson.southChinaSeaLines?.features?.length || 0,
      warningCount:nextGeoJson.warnings?.length || 0,
=======
    await writeTenDash(bucket, nextGeoJson.southChinaSeaTenDashLine, {
      sourceHash,
      checkedAt:now,
      storedAt:now,
      unchanged:false
    });
    await writeMainMeta(bucket, {
      schemaVersion:SCHEMA_VERSION,
      sourceHash,
      checkedAt:now,
      storedAt:now,
      tenDashStoredAt:now,
      generatedAt:nextGeoJson.generatedAt,
      featureCount:nextGeoJson.features?.length || 0,
      tenDashFeatureCount:nextGeoJson.southChinaSeaTenDashLine?.features?.length || 0,
      tenDashSegmentCount:nextGeoJson.southChinaSeaTenDashLine?.segmentCount || 0,
>>>>>>> deb3aac (Switch to Aliyun GeoJson API)
      nextRetryAt:null,
      lastError:null,
      refreshIntervalSeconds:SOURCE_REFRESH_INTERVAL_SECONDS
    });

    return {geoJson:nextGeoJson, cacheStatus:cacheUsable ? 'r2-refreshed-changed' : 'r2-miss-stored'};
  }catch(err){
    if(!cacheUsable) throw err;

    const now = new Date().toISOString();
    await writeMainMeta(bucket, {
      ...meta,
      schemaVersion:SCHEMA_VERSION,
      lastErrorAt:now,
      lastError:err.message || 'Failed to refresh Aliyun DataV GeoJSON',
      nextRetryAt:new Date(Date.now() + REFRESH_ERROR_BACKOFF_SECONDS * 1000).toISOString(),
      refreshIntervalSeconds:SOURCE_REFRESH_INTERVAL_SECONDS
    });
    return {geoJson:cachedGeoJson, cacheStatus:'r2-stale-refresh-error'};
  }
}

async function refreshChinaGeoJson(){
  const response = await fetch(ALIYUN_CHINA_FULL_GEOJSON_URL, {
    headers:{Accept:'application/json'}
  });
  if(!response.ok){
    throw new Error(`Aliyun DataV GeoJSON HTTP ${response.status}`);
  }

  const rawGeoJson = await response.json();
  if(rawGeoJson?.type !== 'FeatureCollection' || !Array.isArray(rawGeoJson.features)){
    throw new Error('Aliyun DataV GeoJSON response is not a FeatureCollection');
  }

  return normalizeAliyunChinaGeoJson(rawGeoJson);
}

<<<<<<< HEAD
async function buildChinaGeoJson(key, secret){
  const country = await fetchDistrict(key, secret, {
    keywords:CHINA_ADCODE,
    subdistrict:1,
    extensions:'all',
    offset:100
  });
  const countryDistrict = country.districts?.[0] || null;
  const provinces = countryDistrict?.districts || [];
  if(!provinces.length){
    throw new Error('AMap did not return province list for China');
  }

  const provinceDetails = await mapWithConcurrency(provinces, 4, async (province) => {
    try{
      const detail = await fetchDistrict(key, secret, {
        keywords:province.adcode,
        subdistrict:0,
        extensions:'all'
      });
      return {district:detail.districts?.[0] || null};
    }catch(err){
      return {
        error:err.message || 'unknown error',
        province:{
          name:province.name,
          adcode:province.adcode
        }
      };
    }
  });
  const sanshaDetail = await fetchOptionalDistrict(key, secret, {
    keywords:SANSHA_ADCODE,
    subdistrict:0,
    extensions:'all'
  });

  const features = provinceDetails
    .map(item => toProvinceFeature(item.district))
    .filter(Boolean);
  const hainanDistrict = provinceDetails.find(item => item.district?.adcode === '460000')?.district || null;
  const warnings = provinceDetails
    .filter(item => item.error)
    .map(item => ({
      name:item.province?.name,
      adcode:item.province?.adcode,
      error:item.error
    }));
  if(sanshaDetail.error){
    warnings.push({
      name:'三沙市',
      adcode:SANSHA_ADCODE,
      error:sanshaDetail.error
    });
  }

  if(!features.length){
    throw new Error('AMap did not return province boundary polylines');
  }
=======
function normalizeAliyunChinaGeoJson(rawGeoJson){
  const normalizedFeatures = rawGeoJson.features
    .map(normalizeFeature)
    .filter(Boolean);
  const tenDashFeatures = normalizedFeatures.filter(isTenDashFeature);
  const areaFeatures = normalizedFeatures.filter(feature => !isTenDashFeature(feature));
  const tenDashFeatureCollection = buildTenDashFeatureCollection(tenDashFeatures);
>>>>>>> deb3aac (Switch to Aliyun GeoJson API)

  return {
    type:'FeatureCollection',
    name:'aliyun-datav-china-provinces',
    schemaVersion:SCHEMA_VERSION,
    source:'aliyun-datav',
    sourceUrl:ALIYUN_CHINA_FULL_GEOJSON_URL,
    generatedAt:new Date().toISOString(),
    refreshIntervalSeconds:SOURCE_REFRESH_INTERVAL_SECONDS,
<<<<<<< HEAD
    southChinaSeaLines:buildSouthChinaSeaLines([
      {sourceName:'中国', sourceType:'country', district:countryDistrict},
      {sourceName:'海南省', sourceType:'province', district:hainanDistrict},
      {sourceName:'三沙市', sourceType:'city', district:sanshaDetail.district}
    ]),
    warnings,
=======
    tenDashSegmentCount:tenDashFeatureCollection.segmentCount,
    southChinaSeaTenDashLine:tenDashFeatureCollection,
    features:[...areaFeatures, ...tenDashFeatures]
  };
}

function normalizeFeature(feature){
  if(!feature?.geometry || !feature?.properties) return null;

  const rawName = String(feature.properties.name || '').trim();
  const adcode = String(feature.properties.adcode || '').trim();
  const adchar = String(feature.properties.adchar || '').trim();
  const tenDash = adcode === '100000_JD' || adchar === 'JD';
  const name = tenDash ? '南海十段线' : shortAreaName(rawName);

  return {
    type:'Feature',
    id:adcode || name,
    properties:{
      ...feature.properties,
      name,
      fullName:rawName || name,
      adcode,
      source:'aliyun-datav',
      role:tenDash ? 'south-china-sea-ten-dash-line' : 'province'
    },
    geometry:feature.geometry
  };
}

function isTenDashFeature(feature){
  return feature?.properties?.role === 'south-china-sea-ten-dash-line';
}

function buildTenDashFeatureCollection(features){
  const segmentCount = features.reduce((count, feature) => {
    return count + countPolygonSegments(feature.geometry);
  }, 0);

  return {
    type:'FeatureCollection',
    name:'aliyun-datav-south-china-sea-ten-dash-line',
    schemaVersion:SCHEMA_VERSION,
    source:'aliyun-datav',
    sourceUrl:ALIYUN_CHINA_FULL_GEOJSON_URL,
    geometryEncoding:'multipolygon-stroke',
    segmentCount,
    generatedAt:new Date().toISOString(),
>>>>>>> deb3aac (Switch to Aliyun GeoJson API)
    features
  };
}

<<<<<<< HEAD
async function fetchOptionalDistrict(key, secret, params){
  try{
    const detail = await fetchDistrict(key, secret, params);
    return {district:detail.districts?.[0] || null};
  }catch(err){
    return {district:null, error:err.message || 'unknown error'};
  }
}

async function fetchDistrict(key, secret, params){
  const authModes = secret ? ['key', 'jscode', 'sig'] : ['key'];
  const results = [];

  for(const authMode of authModes){
    const result = await fetchDistrictOnce(key, secret, params, authMode);
    if(result.data.status === '1') return result.data;
    results.push(result);
  }

  throw new Error([
    'AMap district API failed',
    ...results.map(result => `${result.authMode}=${formatAmapError(result.data)}`)
  ].join('; '));
}

async function fetchDistrictOnce(key, secret, params, authMode){
  const url = new URL(AMAP_DISTRICT_ENDPOINT);
  const query = {
    key,
    output:'JSON',
    ...params
  };
  if(authMode === 'jscode'){
    query.jscode = secret;
  }else if(authMode === 'sig'){
    query.sig = md5(signingSource(query, secret));
  }

  Object.entries(query).forEach(([name, value]) => {
    if(value !== undefined && value !== null) url.searchParams.set(name, String(value));
  });

  const response = await fetch(url.toString(), {
    headers:{Accept:'application/json'}
  });
  if(!response.ok){
    throw new Error(`AMap district API HTTP ${response.status}`);
  }

  const data = await response.json();
  return {data, authMode};
}

function formatAmapError(data){
  if(!data) return 'empty response';
  return `${data.info || 'unknown error'}${data.infocode ? ` (${data.infocode})` : ''}`;
}

function signingSource(params, secret){
  const pairs = Object.entries(params)
    .filter(([, value]) => value !== undefined && value !== null)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, value]) => `${name}=${value}`);
  return `${pairs.join('&')}${secret}`;
=======
function countPolygonSegments(geometry){
  if(!geometry?.coordinates) return 0;
  if(geometry.type === 'Polygon') return 1;
  if(geometry.type === 'MultiPolygon') return geometry.coordinates.length;
  return 0;
>>>>>>> deb3aac (Switch to Aliyun GeoJson API)
}

async function readR2Json(bucket, key){
  const object = await bucket.get(key);
  if(!object) return null;

  try{
    return JSON.parse(await object.text());
  }catch(_err){
    return null;
  }
}

async function writeMainMeta(bucket, meta){
  await bucket.put(R2_META_KEY, JSON.stringify(meta), {
    httpMetadata:{contentType:'application/json; charset=utf-8'}
  });
}

<<<<<<< HEAD
async function writeSouthChinaSeaLines(bucket, lines, meta){
  if(!lines) return;

  await Promise.all([
    bucket.put(R2_SOUTH_CHINA_SEA_LINES_KEY, JSON.stringify(lines), {
      httpMetadata:{contentType:'application/json; charset=utf-8'}
    }),
    writeSouthChinaSeaLinesMeta(bucket, lines, meta)
  ]);
}

async function writeSouthChinaSeaLinesMeta(bucket, lines, meta){
  if(!lines) return;

  await bucket.put(R2_SOUTH_CHINA_SEA_LINES_META_KEY, JSON.stringify({
    ...meta,
    generatedAt:lines.generatedAt,
    featureCount:lines.features?.length || 0,
    source:lines.source,
    extraction:lines.extraction,
=======
async function writeTenDash(bucket, tenDashGeoJson, meta){
  if(!tenDashGeoJson) return;

  await Promise.all([
    bucket.put(R2_TEN_DASH_KEY, JSON.stringify(tenDashGeoJson), {
      httpMetadata:{contentType:'application/json; charset=utf-8'}
    }),
    writeTenDashMeta(bucket, tenDashGeoJson, meta)
  ]);
}

async function writeTenDashMeta(bucket, tenDashGeoJson, meta){
  if(!tenDashGeoJson) return;

  await bucket.put(R2_TEN_DASH_META_KEY, JSON.stringify({
    ...meta,
    schemaVersion:SCHEMA_VERSION,
    generatedAt:tenDashGeoJson.generatedAt,
    featureCount:tenDashGeoJson.features?.length || 0,
    segmentCount:tenDashGeoJson.segmentCount || 0,
    source:tenDashGeoJson.source,
    sourceUrl:tenDashGeoJson.sourceUrl,
    geometryEncoding:tenDashGeoJson.geometryEncoding,
>>>>>>> deb3aac (Switch to Aliyun GeoJson API)
    refreshIntervalSeconds:SOURCE_REFRESH_INTERVAL_SECONDS
  }), {
    httpMetadata:{contentType:'application/json; charset=utf-8'}
  });
}

<<<<<<< HEAD
=======
function getBoundR2Bucket(env){
  return R2_BINDING_NAMES
    .map(name => env[name])
    .find(Boolean) || null;
}

>>>>>>> deb3aac (Switch to Aliyun GeoJson API)
function isFresh(value, ttlSeconds){
  const timestamp = Date.parse(value || '');
  if(!Number.isFinite(timestamp)) return false;
  if(ttlSeconds === 0) return timestamp > Date.now();
  return Date.now() - timestamp < ttlSeconds * 1000;
}

function hasSouthChinaSeaLinesPayload(payload){
  return payload?.southChinaSeaLines?.type === 'FeatureCollection' &&
    Array.isArray(payload.southChinaSeaLines.features) &&
    payload.southChinaSeaLines.schemaVersion === SOUTH_CHINA_SEA_LINES_SCHEMA_VERSION;
}

async function hashGeoJsonSource(geoJson){
  const sourceText = stableStringify({
<<<<<<< HEAD
    hashVersion:2,
    features:geoJson.features || [],
    southChinaSeaLines:geoJson.southChinaSeaLines?.features || [],
    warnings:geoJson.warnings || []
=======
    schemaVersion:SCHEMA_VERSION,
    features:geoJson.features || [],
    tenDashSegmentCount:geoJson.tenDashSegmentCount || 0
>>>>>>> deb3aac (Switch to Aliyun GeoJson API)
  });
  const bytes = new TextEncoder().encode(sourceText);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('');
}

function stableStringify(value){
  if(Array.isArray(value)){
    return `[${value.map(stableStringify).join(',')}]`;
  }
  if(value && typeof value === 'object'){
    return `{${Object.keys(value).sort().map(key => {
      return `${JSON.stringify(key)}:${stableStringify(value[key])}`;
    }).join(',')}}`;
  }
  return JSON.stringify(value);
}

<<<<<<< HEAD
function buildSouthChinaSeaLines(sources){
  const generatedAt = new Date().toISOString();
  const sourceSummaries = [];
  const analyzedParts = [];

  sources
    .filter(source => source?.district?.polyline)
    .forEach((source) => {
      const parts = polylineToLineParts(source.district.polyline)
        .map((coordinates, index) => ({
          coordinates,
          index,
          sourceName:source.sourceName,
          sourceType:source.sourceType,
          sourceAdcode:source.district.adcode,
          metrics:lineMetrics(coordinates)
        }));
      const inFilterBounds = parts.filter(part => intersectsSouthChinaSeaBounds(part.metrics)).length;

      sourceSummaries.push({
        sourceName:source.sourceName,
        sourceType:source.sourceType,
        adcode:source.district.adcode,
        level:source.district.level,
        rawPartCount:parts.length,
        inFilterBounds,
        sampleInFilterBounds:parts
          .filter(part => intersectsSouthChinaSeaBounds(part.metrics))
          .slice(0, 16)
          .map(part => summarizeLinePart(part))
      });
      analyzedParts.push(...parts);
    });

  const lineParts = analyzedParts
    .filter(part => isSouthChinaSeaDashCandidate(part.metrics))
    .filter(uniqueLinePart);

  return {
    type:'FeatureCollection',
    name:'amap-south-china-sea-ten-dash-lines',
    schemaVersion:SOUTH_CHINA_SEA_LINES_SCHEMA_VERSION,
    source:'amap',
    extraction:'district-polyline-multi-source',
    sourceSummaries,
    generatedAt,
    rawPartCount:analyzedParts.length,
    candidateCount:lineParts.length,
    filterBounds:SOUTH_CHINA_SEA_FILTER_BOUNDS,
    features:lineParts.map(part => ({
      type:'Feature',
      id:`south-china-sea-line-${part.sourceAdcode}-${part.index}`,
      properties:{
        name:'南海十段线',
        source:'amap',
        sourceName:part.sourceName,
        sourceType:part.sourceType,
        sourceAdcode:part.sourceAdcode,
        sourcePartIndex:part.index,
        bbox:part.metrics.bbox,
        pointCount:part.metrics.pointCount,
        pathLength:Number(part.metrics.pathLength.toFixed(6))
      },
      geometry:{
        type:'LineString',
        coordinates:part.coordinates
      }
    }))
  };
}

function summarizeLinePart(part){
  return {
    sourcePartIndex:part.index,
    bbox:part.metrics.bbox.map(value => Number(value.toFixed(6))),
    width:Number(part.metrics.width.toFixed(6)),
    height:Number(part.metrics.height.toFixed(6)),
    pathLength:Number(part.metrics.pathLength.toFixed(6)),
    pointCount:part.metrics.pointCount,
    closed:part.metrics.closed,
    candidate:isSouthChinaSeaDashCandidate(part.metrics)
  };
}

function polylineToLineParts(polyline){
  return String(polyline || '')
    .split('|')
    .map(part => part.trim())
    .filter(Boolean)
    .map(part => part
      .split(';')
      .map(parseLngLat)
      .filter(Boolean)
    )
    .filter(coordinates => coordinates.length >= 2);
}

function lineMetrics(coordinates){
  let minLng = Infinity;
  let maxLng = -Infinity;
  let minLat = Infinity;
  let maxLat = -Infinity;
  let pathLength = 0;

  coordinates.forEach(([lng, lat], index) => {
    minLng = Math.min(minLng, lng);
    maxLng = Math.max(maxLng, lng);
    minLat = Math.min(minLat, lat);
    maxLat = Math.max(maxLat, lat);
    if(index > 0){
      const [prevLng, prevLat] = coordinates[index - 1];
      pathLength += Math.hypot(lng - prevLng, lat - prevLat);
    }
  });

  const first = coordinates[0];
  const last = coordinates[coordinates.length - 1];
  const closeDistance = Math.hypot(first[0] - last[0], first[1] - last[1]);
  const width = maxLng - minLng;
  const height = maxLat - minLat;
  const diagonal = Math.hypot(width, height);

  return {
    bbox:[minLng, minLat, maxLng, maxLat],
    width,
    height,
    diagonal,
    pathLength,
    pointCount:coordinates.length,
    closed:closeDistance < 0.05
  };
}

function intersectsSouthChinaSeaBounds(metrics){
  const [minLng, minLat, maxLng, maxLat] = metrics.bbox;
  const bounds = SOUTH_CHINA_SEA_FILTER_BOUNDS;
  return maxLng >= bounds.minLng &&
    minLng <= bounds.maxLng &&
    maxLat >= bounds.minLat &&
    minLat <= bounds.maxLat;
}

function isSouthChinaSeaDashCandidate(metrics){
  const [minLng, minLat, maxLng, maxLat] = metrics.bbox;
  if(!intersectsSouthChinaSeaBounds(metrics)) return false;

  const inMainSouthChinaSea =
    minLng >= 105 &&
    maxLng <= 123.8 &&
    minLat >= 3 &&
    maxLat <= 24.8;
  const inTaiwanEastDash =
    minLng >= 121 &&
    maxLng <= 127 &&
    minLat >= 21 &&
    maxLat <= 27;
  if(!inMainSouthChinaSea && !inTaiwanEastDash) return false;

  if(metrics.closed) return false;
  if(metrics.pathLength < 0.35 || metrics.pathLength > 18) return false;
  if(metrics.width > 12 || metrics.height > 12) return false;
  if(metrics.diagonal > 0 && metrics.pathLength / metrics.diagonal > 2.2) return false;
  return true;
}

function uniqueLinePart(part, index, parts){
  const key = linePartKey(part);
  return parts.findIndex(other => linePartKey(other) === key) === index;
}

function linePartKey(part){
  const first = part.coordinates[0] || [];
  const last = part.coordinates[part.coordinates.length - 1] || [];
  const rounded = [...first, ...last, part.metrics.pointCount].map(value => {
    return Number.isFinite(value) ? Number(value).toFixed(3) : String(value);
  });
  return rounded.join(',');
}

function toProvinceFeature(district){
  const geometry = polylineToMultiPolygon(district?.polyline);
  if(!geometry) return null;

  const fullName = String(district.name || '').trim();
  return {
    type:'Feature',
    id:district.adcode,
    properties:{
      name:shortProvinceName(fullName),
      fullName,
      adcode:district.adcode,
      center:parseLngLat(district.center),
      level:district.level,
      source:'amap'
    },
    geometry
  };
}

function polylineToMultiPolygon(polyline){
  const polygons = String(polyline || '')
    .split('|')
    .map(part => part.trim())
    .filter(Boolean)
    .map((part) => {
      const ring = part
        .split(';')
        .map(parseLngLat)
        .filter(Boolean);
      if(ring.length < 3) return null;
      return [closeRing(ring)];
    })
    .filter(Boolean);

  if(!polygons.length) return null;
  return {
    type:'MultiPolygon',
    coordinates:polygons
  };
}

function parseLngLat(value){
  if(!value) return null;
  const [lng, lat] = String(value).split(',').map(Number);
  if(!Number.isFinite(lng) || !Number.isFinite(lat)) return null;
  return [lng, lat];
}

function closeRing(ring){
  const first = ring[0];
  const last = ring[ring.length - 1];
  if(first[0] === last[0] && first[1] === last[1]) return ring;
  return [...ring, first];
}

async function mapWithConcurrency(items, concurrency, worker){
  const results = new Array(items.length);
  let nextIndex = 0;

  async function run(){
    while(nextIndex < items.length){
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await worker(items[currentIndex], currentIndex);
    }
  }

  await Promise.all(
    Array.from({length:Math.min(concurrency, items.length)}, run)
  );
  return results;
}

function shortProvinceName(name){
=======
function shortAreaName(name){
>>>>>>> deb3aac (Switch to Aliyun GeoJson API)
  return name
    .replace(/特别行政区$/, '')
    .replace(/维吾尔自治区$/, '')
    .replace(/壮族自治区$/, '')
    .replace(/回族自治区$/, '')
    .replace(/自治区$/, '')
    .replace(/[省市]$/, '')
    .trim();
}

function cacheHeaders(headers = {}){
  return {
    'Cache-Control': `public, max-age=${BROWSER_CACHE_SECONDS}, s-maxage=${EDGE_CACHE_SECONDS}, stale-while-revalidate=${SOURCE_REFRESH_INTERVAL_SECONDS}`,
    ...headers
  };
}

function json(body, status = 200, headers = {}){
  return new Response(JSON.stringify(body), {
    status,
    headers:{
      'Content-Type':'application/json; charset=utf-8',
      ...headers
    }
  });
}
