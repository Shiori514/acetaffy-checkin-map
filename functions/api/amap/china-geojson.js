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
  const cache = typeof caches !== 'undefined' ? caches.default : null;

  try{
    const cached = cache ? await cache.match(cacheKey) : null;
    if(cached) return cached;

    const geoJson = await buildChinaGeoJson(AMAP_KEY, AMAP_SECRET);
    const response = json(geoJson, 200, {
      'Cache-Control': `public, max-age=${CACHE_SECONDS}, s-maxage=${EDGE_CACHE_SECONDS}, stale-while-revalidate=${EDGE_CACHE_SECONDS}`
    });
    if(cache) context.waitUntil(cache.put(cacheKey, response.clone()));
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
  const jscodeResult = await fetchDistrictOnce(key, secret, params, 'jscode');
  if(jscodeResult.data.status === '1') return jscodeResult.data;

  const signedResult = await fetchDistrictOnce(key, secret, params, 'sig');
  if(signedResult.data.status === '1') return signedResult.data;

  throw new Error([
    'AMap district API failed',
    `jscode=${formatAmapError(jscodeResult.data)}`,
    `sig=${formatAmapError(signedResult.data)}`
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
