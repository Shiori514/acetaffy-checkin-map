const AMAP_DISTRICT_ENDPOINT = 'https://restapi.amap.com/v3/config/district';
const CHINA_ADCODE = '100000';
const CACHE_SECONDS = 60 * 60 * 24;
const EDGE_CACHE_SECONDS = CACHE_SECONDS * 7;

export async function onRequest(context){
  if(context.request.method !== 'GET'){
    return json({error:'Method Not Allowed'}, 405, {Allow:'GET'});
  }

  const {AMAP_KEY, AMAP_SECRET} = context.env;
  if(!AMAP_KEY || !AMAP_SECRET){
    return json({error:'AMAP_KEY and AMAP_SECRET are required'}, 500);
  }

  const cacheKey = new Request(new URL(context.request.url).origin + '/api/amap/china-geojson?v=1');
  const cached = await caches.default.match(cacheKey);
  if(cached) return cached;

  try{
    const geoJson = await buildChinaGeoJson(AMAP_KEY, AMAP_SECRET);
    const response = json(geoJson, 200, {
      'Cache-Control': `public, max-age=${CACHE_SECONDS}, s-maxage=${EDGE_CACHE_SECONDS}, stale-while-revalidate=${EDGE_CACHE_SECONDS}`
    });
    context.waitUntil(caches.default.put(cacheKey, response.clone()));
    return response;
  }catch(err){
    return json({error:err.message || 'Failed to load AMap district data'}, 502, {
      'Cache-Control':'no-store'
    });
  }
}

async function buildChinaGeoJson(key, secret){
  const country = await fetchDistrict(key, secret, {
    keywords:CHINA_ADCODE,
    subdistrict:1,
    extensions:'base',
    offset:100
  });
  const provinces = country.districts?.[0]?.districts || [];
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
    warnings,
    features
  };
}

async function fetchDistrict(key, secret, params){
  const url = new URL(AMAP_DISTRICT_ENDPOINT);
  const query = {
    key,
    jscode:secret,
    output:'JSON',
    ...params
  };

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
  if(data.status !== '1'){
    throw new Error(`AMap district API failed: ${data.info || data.infocode || 'unknown error'}`);
  }
  return data;
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

function json(body, status = 200, headers = {}){
  return new Response(JSON.stringify(body), {
    status,
    headers:{
      'Content-Type':'application/json; charset=utf-8',
      ...headers
    }
  });
}
