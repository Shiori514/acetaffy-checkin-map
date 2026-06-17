const AMAP_DISTRICT_ENDPOINT = 'https://restapi.amap.com/v3/config/district';
const CHINA_ADCODE = '100000';
const R2_BINDING_NAME = 'AMAP_GEOJSON_BUCKET';
const R2_GEOJSON_KEY = 'amap/china-geojson.json';
const R2_META_KEY = 'amap/china-geojson-meta.json';
const R2_SOUTH_CHINA_SEA_LINES_KEY = 'amap/south-china-sea-ten-dash-lines.json';
const R2_SOUTH_CHINA_SEA_LINES_META_KEY = 'amap/south-china-sea-ten-dash-lines-meta.json';
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

  const cacheKey = new Request(new URL(context.request.url).origin + '/api/amap/china-geojson?v=3');
  const cache = typeof caches !== 'undefined' ? caches.default : null;

  try{
    const cached = cache ? await cache.match(cacheKey) : null;
    if(cached) return cached;

    const bucket = context.env[R2_BINDING_NAME] || null;
    const result = bucket
      ? await getGeoJsonWithR2Cache(context, bucket)
      : {
        geoJson:await refreshChinaGeoJson(context.env),
        cacheStatus:'edge-only'
      };

    const response = json(result.geoJson, 200, cacheHeaders({
      'X-Map-Cache':result.cacheStatus
    }));
    if(cache) context.waitUntil(cache.put(cacheKey, response.clone()));
    return response;
  }catch(err){
    return json({error:err.message || 'Failed to load AMap district data'}, 502, {
      'Cache-Control':'no-store'
    });
  }
}

async function getGeoJsonWithR2Cache(context, bucket){
  const [cachedGeoJson, meta] = await Promise.all([
    readR2Json(bucket, R2_GEOJSON_KEY),
    readR2Json(bucket, R2_META_KEY)
  ]);

  const needsSouthChinaSeaLines = !hasSouthChinaSeaLinesPayload(cachedGeoJson);

  if(cachedGeoJson && !needsSouthChinaSeaLines && isFresh(meta?.checkedAt, SOURCE_REFRESH_INTERVAL_SECONDS)){
    return {geoJson:cachedGeoJson, cacheStatus:'r2-hit'};
  }

  if(cachedGeoJson && !needsSouthChinaSeaLines && isFresh(meta?.nextRetryAt, 0)){
    return {geoJson:cachedGeoJson, cacheStatus:'r2-stale-backoff'};
  }

  try{
    const nextGeoJson = await refreshChinaGeoJson(context.env);
    const sourceHash = await hashGeoJsonSource(nextGeoJson);
    const now = new Date().toISOString();

    if(cachedGeoJson && meta?.sourceHash === sourceHash){
      await writeR2Meta(bucket, {
        ...meta,
        checkedAt:now,
        lastUnchangedAt:now,
        nextRetryAt:null,
        lastError:null,
        refreshIntervalSeconds:SOURCE_REFRESH_INTERVAL_SECONDS
      });
      await writeSouthChinaSeaLinesMeta(bucket, cachedGeoJson.southChinaSeaLines, {
        sourceHash,
        checkedAt:now,
        storedAt:meta?.southChinaSeaLinesStoredAt || meta?.storedAt || now,
        unchanged:true
      });
      return {geoJson:cachedGeoJson, cacheStatus:'r2-revalidated-unchanged'};
    }

    await bucket.put(R2_GEOJSON_KEY, JSON.stringify(nextGeoJson), {
      httpMetadata:{contentType:'application/json; charset=utf-8'}
    });
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
      generatedAt:nextGeoJson.generatedAt,
      featureCount:nextGeoJson.features?.length || 0,
      southChinaSeaLineCount:nextGeoJson.southChinaSeaLines?.features?.length || 0,
      warningCount:nextGeoJson.warnings?.length || 0,
      nextRetryAt:null,
      lastError:null,
      refreshIntervalSeconds:SOURCE_REFRESH_INTERVAL_SECONDS
    });

    return {geoJson:nextGeoJson, cacheStatus:cachedGeoJson ? 'r2-refreshed-changed' : 'r2-miss-stored'};
  }catch(err){
    if(!cachedGeoJson) throw err;

    const now = new Date().toISOString();
    await writeR2Meta(bucket, {
      ...meta,
      lastErrorAt:now,
      lastError:err.message || 'Failed to refresh AMap district data',
      nextRetryAt:new Date(Date.now() + REFRESH_ERROR_BACKOFF_SECONDS * 1000).toISOString(),
      refreshIntervalSeconds:SOURCE_REFRESH_INTERVAL_SECONDS
    });
    return {geoJson:cachedGeoJson, cacheStatus:'r2-stale-refresh-error'};
  }
}

async function refreshChinaGeoJson(env){
  const {AMAP_KEY, AMAP_SECRET} = env;
  if(!AMAP_KEY){
    throw new Error('AMAP_KEY is required to refresh AMap district data');
  }
  return buildChinaGeoJson(AMAP_KEY, AMAP_SECRET || '');
}

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

  const features = provinceDetails
    .map(item => toProvinceFeature(item.district))
    .filter(Boolean);
  const warnings = provinceDetails
    .filter(item => item.error)
    .map(item => ({
      name:item.province?.name,
      adcode:item.province?.adcode,
      error:item.error
    }));

  if(!features.length){
    throw new Error('AMap did not return province boundary polylines');
  }

  return {
    type:'FeatureCollection',
    name:'amap-china-provinces',
    source:'amap',
    generatedAt:new Date().toISOString(),
    refreshIntervalSeconds:SOURCE_REFRESH_INTERVAL_SECONDS,
    southChinaSeaLines:buildSouthChinaSeaLines(countryDistrict),
    warnings,
    features
  };
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

async function writeR2Meta(bucket, meta){
  await bucket.put(R2_META_KEY, JSON.stringify(meta), {
    httpMetadata:{contentType:'application/json; charset=utf-8'}
  });
}

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
    refreshIntervalSeconds:SOURCE_REFRESH_INTERVAL_SECONDS
  }), {
    httpMetadata:{contentType:'application/json; charset=utf-8'}
  });
}

function isFresh(value, ttlSeconds){
  const timestamp = Date.parse(value || '');
  if(!Number.isFinite(timestamp)) return false;
  if(ttlSeconds === 0) return timestamp > Date.now();
  return Date.now() - timestamp < ttlSeconds * 1000;
}

function hasSouthChinaSeaLinesPayload(payload){
  return payload?.southChinaSeaLines?.type === 'FeatureCollection' &&
    Array.isArray(payload.southChinaSeaLines.features);
}

async function hashGeoJsonSource(geoJson){
  const sourceText = stableStringify({
    hashVersion:2,
    features:geoJson.features || [],
    southChinaSeaLines:geoJson.southChinaSeaLines?.features || [],
    warnings:geoJson.warnings || []
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

function buildSouthChinaSeaLines(countryDistrict){
  const generatedAt = new Date().toISOString();
  const analyzedParts = polylineToLineParts(countryDistrict?.polyline)
    .map((coordinates, index) => ({
      coordinates,
      index,
      metrics:lineMetrics(coordinates)
    }));
  const lineParts = analyzedParts
    .filter(part => isSouthChinaSeaDashCandidate(part.metrics));

  return {
    type:'FeatureCollection',
    name:'amap-south-china-sea-ten-dash-lines',
    source:'amap',
    extraction:'country-district-polyline',
    sourceDistrict:{
      name:countryDistrict?.name || '中国',
      adcode:countryDistrict?.adcode || CHINA_ADCODE,
      level:countryDistrict?.level || 'country'
    },
    generatedAt,
    rawPartCount:analyzedParts.length,
    candidateCount:lineParts.length,
    filterBounds:SOUTH_CHINA_SEA_FILTER_BOUNDS,
    features:lineParts.map(part => ({
      type:'Feature',
      id:`south-china-sea-line-${part.index}`,
      properties:{
        name:'南海十段线',
        source:'amap',
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

function isSouthChinaSeaDashCandidate(metrics){
  const [minLng, minLat, maxLng, maxLat] = metrics.bbox;
  const bounds = SOUTH_CHINA_SEA_FILTER_BOUNDS;
  const intersectsFilterBounds =
    maxLng >= bounds.minLng &&
    minLng <= bounds.maxLng &&
    maxLat >= bounds.minLat &&
    minLat <= bounds.maxLat;
  if(!intersectsFilterBounds) return false;

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

function md5(input){
  const bytes = utf8Bytes(input);
  let originalBitLength = bytes.length * 8;
  bytes.push(0x80);
  while(bytes.length % 64 !== 56) bytes.push(0);
  for(let i = 0; i < 8; i += 1){
    bytes.push(originalBitLength & 0xff);
    originalBitLength = Math.floor(originalBitLength / 256);
  }

  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;

  const s = [
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
    5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
    4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
    6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21
  ];
  const k = [
    0xd76aa478, 0xe8c7b756, 0x242070db, 0xc1bdceee,
    0xf57c0faf, 0x4787c62a, 0xa8304613, 0xfd469501,
    0x698098d8, 0x8b44f7af, 0xffff5bb1, 0x895cd7be,
    0x6b901122, 0xfd987193, 0xa679438e, 0x49b40821,
    0xf61e2562, 0xc040b340, 0x265e5a51, 0xe9b6c7aa,
    0xd62f105d, 0x02441453, 0xd8a1e681, 0xe7d3fbc8,
    0x21e1cde6, 0xc33707d6, 0xf4d50d87, 0x455a14ed,
    0xa9e3e905, 0xfcefa3f8, 0x676f02d9, 0x8d2a4c8a,
    0xfffa3942, 0x8771f681, 0x6d9d6122, 0xfde5380c,
    0xa4beea44, 0x4bdecfa9, 0xf6bb4b60, 0xbebfbc70,
    0x289b7ec6, 0xeaa127fa, 0xd4ef3085, 0x04881d05,
    0xd9d4d039, 0xe6db99e5, 0x1fa27cf8, 0xc4ac5665,
    0xf4292244, 0x432aff97, 0xab9423a7, 0xfc93a039,
    0x655b59c3, 0x8f0ccc92, 0xffeff47d, 0x85845dd1,
    0x6fa87e4f, 0xfe2ce6e0, 0xa3014314, 0x4e0811a1,
    0xf7537e82, 0xbd3af235, 0x2ad7d2bb, 0xeb86d391
  ];

  for(let offset = 0; offset < bytes.length; offset += 64){
    const m = new Array(16);
    for(let i = 0; i < 16; i += 1){
      const j = offset + i * 4;
      m[i] = bytes[j] | (bytes[j + 1] << 8) | (bytes[j + 2] << 16) | (bytes[j + 3] << 24);
    }

    let a = a0;
    let b = b0;
    let c = c0;
    let d = d0;

    for(let i = 0; i < 64; i += 1){
      let f;
      let g;
      if(i < 16){
        f = (b & c) | (~b & d);
        g = i;
      }else if(i < 32){
        f = (d & b) | (~d & c);
        g = (5 * i + 1) % 16;
      }else if(i < 48){
        f = b ^ c ^ d;
        g = (3 * i + 5) % 16;
      }else{
        f = c ^ (b | ~d);
        g = (7 * i) % 16;
      }

      const temp = d;
      d = c;
      c = b;
      b = add32(b, leftRotate(add32(add32(a, f), add32(k[i], m[g])), s[i]));
      a = temp;
    }

    a0 = add32(a0, a);
    b0 = add32(b0, b);
    c0 = add32(c0, c);
    d0 = add32(d0, d);
  }

  return [a0, b0, c0, d0].map(wordToHex).join('');
}

function utf8Bytes(input){
  const bytes = [];
  for(let i = 0; i < input.length; i += 1){
    let code = input.charCodeAt(i);
    if(code < 0x80){
      bytes.push(code);
    }else if(code < 0x800){
      bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    }else if(code >= 0xd800 && code <= 0xdbff){
      i += 1;
      const next = input.charCodeAt(i);
      code = 0x10000 + (((code & 0x3ff) << 10) | (next & 0x3ff));
      bytes.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f)
      );
    }else{
      bytes.push(
        0xe0 | (code >> 12),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f)
      );
    }
  }
  return bytes;
}

function add32(a, b){
  return (a + b) >>> 0;
}

function leftRotate(value, amount){
  return ((value << amount) | (value >>> (32 - amount))) >>> 0;
}

function wordToHex(word){
  let output = '';
  for(let i = 0; i < 4; i += 1){
    output += ((word >>> (i * 8)) & 0xff).toString(16).padStart(2, '0');
  }
  return output;
}
