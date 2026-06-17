const ALIYUN_CHINA_FULL_GEOJSON_URL = 'https://geo.datav.aliyun.com/areas_v3/bound/100000_full.json';
const R2_BINDING_NAMES = ['ALIYUN_GEOJSON_BUCKET', 'AMAP_GEOJSON_BUCKET'];
const R2_GEOJSON_KEY = 'aliyun/china-geojson.json';
const R2_META_KEY = 'aliyun/china-geojson-meta.json';
const R2_TEN_DASH_KEY = 'aliyun/south-china-sea-ten-dash-line.json';
const R2_TEN_DASH_META_KEY = 'aliyun/south-china-sea-ten-dash-line-meta.json';
const SCHEMA_VERSION = 1;
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

  const cacheKey = new Request(new URL(context.request.url).origin + '/api/amap/china-geojson?source=aliyun-datav&v=1');
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
      return {geoJson:cachedGeoJson, cacheStatus:'r2-revalidated-unchanged'};
    }

    await bucket.put(R2_GEOJSON_KEY, JSON.stringify(nextGeoJson), {
      httpMetadata:{contentType:'application/json; charset=utf-8'}
    });
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

function normalizeAliyunChinaGeoJson(rawGeoJson){
  const normalizedFeatures = rawGeoJson.features
    .map(normalizeFeature)
    .filter(Boolean);
  const tenDashFeatures = normalizedFeatures.filter(isTenDashFeature);
  const areaFeatures = normalizedFeatures.filter(feature => !isTenDashFeature(feature));
  const tenDashFeatureCollection = buildTenDashFeatureCollection(tenDashFeatures);

  return {
    type:'FeatureCollection',
    name:'aliyun-datav-china-provinces',
    schemaVersion:SCHEMA_VERSION,
    source:'aliyun-datav',
    sourceUrl:ALIYUN_CHINA_FULL_GEOJSON_URL,
    generatedAt:new Date().toISOString(),
    refreshIntervalSeconds:SOURCE_REFRESH_INTERVAL_SECONDS,
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
    features
  };
}

function countPolygonSegments(geometry){
  if(!geometry?.coordinates) return 0;
  if(geometry.type === 'Polygon') return 1;
  if(geometry.type === 'MultiPolygon') return geometry.coordinates.length;
  return 0;
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
    refreshIntervalSeconds:SOURCE_REFRESH_INTERVAL_SECONDS
  }), {
    httpMetadata:{contentType:'application/json; charset=utf-8'}
  });
}

function getBoundR2Bucket(env){
  return R2_BINDING_NAMES
    .map(name => env[name])
    .find(Boolean) || null;
}

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
    schemaVersion:SCHEMA_VERSION,
    features:geoJson.features || [],
    tenDashSegmentCount:geoJson.tenDashSegmentCount || 0
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

function shortAreaName(name){
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
