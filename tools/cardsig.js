/* Empreinte visuelle d'une carte : pHash 64 bits de la carte entière et de l'illustration (identique dans l'app et l'index) */
const CARDSIG = (()=>{
  const N = 32, M = 96;
  const big = document.createElement("canvas"); big.width = M; big.height = M;
  const bg = big.getContext("2d", {willReadFrequently:true});
  const sm = document.createElement("canvas"); sm.width = N; sm.height = N;
  const sg = sm.getContext("2d", {willReadFrequently:true});
  const COS = new Float64Array(8*N);
  for(let u=0; u<8; u++) for(let x=0; x<N; x++) COS[u*N+x] = Math.cos((2*x+1)*u*Math.PI/(2*N));
  const ART = [.08, .11, .84, .42];
  function phash(src, x, y, w, h){
    bg.imageSmoothingEnabled = true; bg.imageSmoothingQuality = "high";
    bg.clearRect(0,0,M,M); bg.drawImage(src, x, y, w, h, 0, 0, M, M);
    sg.imageSmoothingEnabled = true; sg.imageSmoothingQuality = "high";
    sg.clearRect(0,0,N,N); sg.drawImage(big, 0, 0, M, M, 0, 0, N, N);
    const d = sg.getImageData(0,0,N,N).data, L = new Float64Array(N*N);
    for(let i=0, j=0; j<N*N; i+=4, j++) L[j] = .299*d[i] + .587*d[i+1] + .114*d[i+2];
    const T = new Float64Array(8*N);
    for(let u=0; u<8; u++) for(let yy=0; yy<N; yy++){ let s=0; const r=yy*N, c=u*N; for(let xx=0; xx<N; xx++) s += COS[c+xx]*L[r+xx]; T[u*N+yy] = s; }
    const D = new Float64Array(64);
    for(let v=0; v<8; v++) for(let u=0; u<8; u++){ let s=0; for(let yy=0; yy<N; yy++) s += COS[v*N+yy]*T[u*N+yy]; D[v*8+u] = s; }
    const vals = Array.from(D).slice(1).sort((a,b)=>a-b), med = (vals[30]+vals[31])/2;
    let a = 0, b = 0;
    for(let k=1; k<64; k++) if(D[k] > med){ if(k<32) a |= (1<<k); else b |= (1<<(k-32)); }
    return [a>>>0, b>>>0];
  }
  const hex = h => h[0].toString(16).padStart(8,"0") + h[1].toString(16).padStart(8,"0");
  function sig(src, x, y, w, h){
    return {full: phash(src, x, y, w, h), art: phash(src, x+w*ART[0], y+h*ART[1], w*ART[2], h*ART[3])};
  }
  function pop(n){ n = n - ((n>>>1) & 0x55555555); n = (n & 0x33333333) + ((n>>>2) & 0x33333333); return (((n + (n>>>4)) & 0x0F0F0F0F) * 0x01010101) >>> 24; }
  const dist = (p, q) => pop(p[0]^q[0]) + pop(p[1]^q[1]);
  const parse = s => [parseInt(s.slice(0,8),16)>>>0, parseInt(s.slice(8,16),16)>>>0];
  return {sig, hex, dist, parse, pop};
})();
