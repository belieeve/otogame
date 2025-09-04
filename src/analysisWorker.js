// analysisWorker.js - Web Worker for audio feature analysis (BPM)
// Receives messages: { type: 'bpm', sampleRate, data(Float32Array) }
// Responds: { type: 'bpm', bpm }

self.onmessage = (e) => {
  const msg = e.data;
  if (!msg || !msg.type) return;
  try {
    if (msg.type === 'bpm') {
      const { sampleRate, data } = msg;
      const bpm = analyzeBPM(data, sampleRate);
      self.postMessage({ type: 'bpm', bpm });
    }
  } catch (err) {
    self.postMessage({ type: 'error', error: String(err) });
  }
};

function analyzeBPM(data, sampleRate) {
  const frameSize = 1024, hopSize = 512;
  const window = hann(frameSize);
  const fft = new FFT(frameSize);
  const flux = [];
  let prevMag = null;
  const maxSamples = Math.min(data.length, Math.floor(sampleRate * 60));
  for (let i = 0; i + frameSize < maxSamples; i += hopSize) {
    const frame = data.subarray(i, i + frameSize);
    const w = applyWindow(frame, window);
    const spec = fft.magnitude(w);
    if (prevMag) {
      let sum = 0;
      for (let k = 0; k < spec.length; k++) { const diff = spec[k] - prevMag[k]; if (diff > 0) sum += diff; }
      flux.push(sum);
    } else {
      flux.push(0);
    }
    prevMag = spec;
  }
  const normFlux = normalize(flux);
  const fps = sampleRate / hopSize;
  return estimateBPM(normFlux, fps);
}

function hann(n) {
  const w = new Float32Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 * (1 - Math.cos((2*Math.PI*i)/(n-1)));
  return w;
}
function applyWindow(x, w) {
  const out = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) out[i] = x[i]*w[i];
  return out;
}
class FFT {
  constructor(n) { this.n = n; this.rev = FFT.makeRev(n); this.cos = new Float32Array(n/2); this.sin = new Float32Array(n/2);
    for (let i=0;i<n/2;i++){ this.cos[i]=Math.cos(-2*Math.PI*i/n); this.sin[i]=Math.sin(-2*Math.PI*i/n);} }
  static makeRev(n){ const r=new Uint32Array(n); let j=0; for(let i=0;i<n;i++){ r[i]=j; let bit=n>>1; while(j & bit){ j^=bit; bit>>=1; } j|=bit; } return r; }
  magnitude(x){
    const n=this.n; const re=new Float32Array(n); const im=new Float32Array(n);
    for(let i=0;i<n;i++){ const ri=this.rev[i]; re[i]=x[ri]||0; im[i]=0; }
    for(let s=1; s<=Math.log2(n); s++){
      const m=1<<s; const m2=m>>1; const step=n/m;
      for(let k=0;k<n;k+=m){
        for(let j=0;j<m2;j++){
          const tpre = this.cos[j*step]*re[k+j+m2] - this.sin[j*step]*im[k+j+m2];
          const tpim = this.sin[j*step]*re[k+j+m2] + this.cos[j*step]*im[k+j+m2];
          re[k+j+m2] = re[k+j]-tpre; im[k+j+m2]=im[k+j]-tpim;
          re[k+j] += tpre;          im[k+j] += tpim;
        }
      }
    }
    const magLen = n/2;
    const mag = new Float32Array(magLen);
    for(let i=0;i<magLen;i++){ mag[i]=Math.hypot(re[i], im[i]); }
    return mag;
  }
}

function normalize(arr) {
  const max = Math.max(...arr);
  if (max === 0) return arr.map(()=>0);
  return arr.map(v => v / max);
}

function estimateBPM(onsetCurve, fps) {
  const minBPM = 60, maxBPM = 200;
  const minLag = Math.floor((60/maxBPM) * fps);
  const maxLag = Math.floor((60/minBPM) * fps);
  let bestLag = 0, bestVal = 0;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let sum = 0;
    for (let i = 0; i < onsetCurve.length - lag; i++) sum += onsetCurve[i] * onsetCurve[i+lag];
    if (sum > bestVal) { bestVal = sum; bestLag = lag; }
  }
  if (bestLag === 0) return null;
  let bpm = 60 * fps / bestLag;
  while (bpm < 80) bpm *= 2;
  while (bpm > 160) bpm /= 2;
  return Math.round(bpm);
}

