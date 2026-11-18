// Keep recorded fractional precision for chronology; dispatch receipts use
// their fixed microsecond precision, matching the audit's datetime boundary.
function point(value){
 if(typeof value!=='string')return null;
 const match=/^\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}:\d{2}(?:\.(\d+))?(?:Z|[+-]\d{2}:\d{2})$/.exec(value);
 const ms=Date.parse(value);if(!match||!Number.isFinite(ms))return null;
 const fraction=match[1]??'';
 return {seconds:(BigInt(ms)-BigInt(fraction.slice(0,3).padEnd(3,'0')))/1000n,fraction};
}
export function researchMicros(value){
 const p=point(value);return p===null?null:p.seconds*1000000n+BigInt(p.fraction.slice(0,6).padEnd(6,'0'));
}
export function receiptMicros(value){
 if(typeof value!=='string'||!/^\d{10}\.\d{6}$/.test(value))return null;
 const [seconds,fraction]=value.split('.');return BigInt(seconds)*1000000n+BigInt(fraction);
}
// A coarse record denotes a precision interval, not an invented exact instant.
export function researchTimeNotBefore(late,early){
 const x=point(late),y=point(early);if(x===null||y===null)return null;
 const digits=x.fraction.split('');let carry=true;
 for(let i=digits.length-1;i>=0&&carry;i--){if(digits[i]==='9')digits[i]='0';else{digits[i]=String(Number(digits[i])+1);carry=false;}}
 const seconds=x.seconds+(carry?1n:0n),fraction=digits.join('');
 if(seconds!==y.seconds)return seconds>y.seconds;
 const width=Math.max(fraction.length,y.fraction.length);
 return fraction.padEnd(width,'0')>y.fraction.padEnd(width,'0');
}
