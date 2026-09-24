import { useState, useEffect } from 'react';

export default function VerifyPage({ id }: { id: string }) {
  const [data, setData] = useState<any>(null);
  const [note, setNote] = useState('');

  useEffect(() => {
    fetch(`/api/verify/${encodeURIComponent(id)}`).then(r => r.ok ? r.json() : null).then(d => d && setData(d));
  }, [id]);

  if (!data) return <div style={{padding:48,textAlign:'center',fontFamily:'system-ui',color:'#444'}}>Loading verification…</div>;

  return (
    <div style={{padding:20,fontFamily:'system-ui,sans-serif',maxWidth:640,margin:'0 auto',color:'#1a1a2e',background:'linear-gradient(180deg,#fafafa 0%,#fff 100%)',minHeight:'100vh'}}>
      <header style={{marginBottom:24,paddingBottom:16,borderBottom:'2px solid #e8e8f0'}}>
        <h1 style={{fontSize:26,fontWeight:800,margin:0,letterSpacing:-1,color:'#111'}}>Verification</h1>
        <div style={{marginTop:6,fontSize:14,color:'#555'}}>
          <strong>{data.profileLabel || data.profileId || 'Embedded'}</strong> · <span style={{color:'#777'}}>{data.goal}</span>
        </div>
        <div style={{marginTop:8,display:'flex',gap:8,alignItems:'center'}}>
          <span style={{padding:'4px 12px',borderRadius:20,fontSize:12,fontWeight:700,textTransform:'uppercase',letterSpacing:0.5,background:data.status==='awaiting_human'?'#ffebee':data.status==='researching'?'#fff3e0':'#e8f5e9',color:data.status==='awaiting_human'?'#b71c1c':data.status==='researching'?'#e65100':'#2e7d32'}}>
            {data.status}
          </span>
          <span style={{fontSize:12,color:'#999'}}>Fusion active · Reasoning enforced</span>
        </div>
      </header>

      <section style={{marginBottom:28}}>
        <h2 style={{fontSize:12,textTransform:'uppercase',letterSpacing:1.5,color:'#888',margin:'0 0 12px',fontWeight:600}}>Verification Ladder</h2>
        <div style={{display:'flex',gap:8,flexWrap:'wrap'}}>
          {(data.ladder || ['research','sim','bench-test','human-eyes']).map((r:string) => (
            <span key={r} style={{padding:'6px 14px',borderRadius:12,fontSize:13,fontWeight:600,background:'#f0f0f7',color:'#333',border:'1px solid #ddd',boxShadow:'0 1px 0 rgba(0,0,0,.04)'}}>{r}</span>
          ))}
        </div>
      </section>

      <section style={{marginBottom:28}}>
        <h2 style={{fontSize:16,fontWeight:700,margin:'0 0 14px'}}>Parts</h2>
        {(data.partLadders || []).map((p:any) => (
          <article key={p.partId} style={{border:'1px solid #e2e2ea',borderRadius:16,padding:18,marginBottom:14,background:'#fff',boxShadow:'0 4px 20px rgba(0,0,0,.04)'}}>
            <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:10}}>
              <h3 style={{fontSize:17,fontWeight:700,margin:0,color:'#1a1a2e'}}>{p.name}</h3>
              <span style={{fontSize:11,fontWeight:700,padding:'4px 10px',borderRadius:8,background:p.status==='verified'?'#c8e6c9':p.status==='failed'?'#ffcdd2':p.status==='awaiting_human'?'#fff3e0':'#fff9c4',color:p.status==='verified'?'#1b5e20':p.status==='failed'?'#b71c1c':p.status==='awaiting_human'?'#e65100':'#f57f17'}}>{p.status}</span>
            </div>
            <div style={{display:'flex',gap:8,flexWrap:'wrap',marginBottom:12}}>
              {(p.rungs || []).map((r:any) => (
                <button key={r.rung} onClick={() => { const rs = prompt('Reasoning?'); if (rs) fetch(`/api/verify/${id}/rung`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({partId:p.partId,rung:r.rung,summary:r.rung+' check',reasoning:rs})}).then(()=>window.location.reload()); }} style={{padding:'6px 14px',borderRadius:8,border:'none',fontSize:12,fontWeight:600,background:r.done?'#c8e6c9':'#f0f0f7',color:r.done?'#1b5e20':'#555',cursor:'pointer',boxShadow:r.done?'0 2px 6px rgba(76,175,80,.15)':'none'}}> {r.rung} {r.done?'✓':''}</button>
              ))}
            </div>
            {(p.rungs || []).flatMap((r:any) => r.evidence || []).map((e:any,i:number) => (
              <div key={i} style={{background:'#fafafa',border:'1px solid #ececf1',borderRadius:10,padding:12,marginBottom:8}}>
                <div style={{display:'flex',justifyContent:'space-between',fontSize:12,fontWeight:600,color:'#444'}}>
                  <span>{e.rung}</span>
                  <span style={{fontSize:11,color:'#888'}}>Evidence #{i+1}</span>
                </div>
                <div style={{fontSize:14,color:'#222',margin:'4px 0',fontWeight:500}}>{e.summary}</div>
                <div style={{fontSize:13,color:'#555',fontStyle:'italic',marginBottom:4}}>Reasoning: {e.reasoning || '—'}</div>
                <div style={{fontSize:11,color:'#777'}}>Source: {e.source || 'auto'} · {e.ts ? new Date(e.ts).toLocaleString() : ''}</div>
              </div>
            ))}
            {p.humanCheckpoint && <div style={{fontSize:13,color:'#e65100',fontWeight:600,marginTop:6,padding:'6px 10px',borderRadius:6,background:'#fff3e0'}}>⏳ Human eyes needed</div>}
            {p.needsInput && <div style={{fontSize:13,color:'#c62828',fontWeight:600,marginTop:6,padding:'6px 10px',borderRadius:6,background:'#ffebee'}}>⚠️ Needs input — challenge recorded</div>}
          </article>
        ))}
      </section>

      <section style={{marginBottom:24,padding:20,border:'2px solid #ff9800',borderRadius:16,background:'linear-gradient(180deg,#fff8e1 0%,#fff 100%)',boxShadow:'0 4px 20px rgba(255,152,0,.1)'}}>
        <h2 style={{fontSize:14,textTransform:'uppercase',letterSpacing:1.5,color:'#777',margin:'0 0 6px',fontWeight:700}}>Negotiation — Human Gate</h2>
        <p style={{fontSize:13,color:'#555',margin:'0 0 12px',lineHeight:1.5}}>Dispute evidence with measurements. Approve only with reasoning. The brain explains; you decide.</p>
        <textarea value={note} onChange={e=>setNote(e.target.value)} placeholder="Your reasoning / correction / dispute… (required for brain)" style={{width:'100%',minHeight:80,padding:12,borderRadius:12,border:'1px solid #ccc',fontSize:15,fontFamily:'inherit',resize:'vertical',background:'#fff',lineHeight:1.45}} />
        <div style={{marginTop:12,display:'flex',gap:10,flexWrap:'wrap'}}>
          <button onClick={()=>fetch(`/api/verify/${id}/gate`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({decision:'approve',reason:note||''})}).then(()=>window.location.reload())} style={{padding:'12px 22px',borderRadius:10,border:'none',background:'#2e7d32',color:'#fff',fontWeight:700,fontSize:14,boxShadow:'0 4px 12px rgba(46,125,50,.3)',cursor:'pointer'}}>Approve</button>
          <button onClick={()=>fetch(`/api/verify/${id}/gate`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({decision:'needs-input',reason:note||''})}).then(()=>window.location.reload())} style={{padding:'12px 22px',borderRadius:10,border:'none',background:'#f57c00',color:'#fff',fontWeight:700,fontSize:14,boxShadow:'0 4px 12px rgba(245,124,0,.3)',cursor:'pointer'}}>Needs Input</button>
          <button onClick={()=>fetch(`/api/verify/${id}/challenge`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({partId:(data?.partLadders||[{}])[0]?.partId||'',rung:'research',reason:note||''})}).then(()=>window.location.reload())} style={{padding:'12px 22px',borderRadius:10,border:'none',background:'#c62828',color:'#fff',fontWeight:700,fontSize:14,boxShadow:'0 4px 12px rgba(198,40,40,.3)',cursor:'pointer'}}>Reject / Challenge</button>
        </div>
      </section>

      <footer style={{fontSize:11,color:'#999',borderTop:'1px solid #ddd',paddingTop:12,marginTop:12,display:'flex',justifyContent:'space-between',alignItems:'center'}}>
        <span>WireGI · Fusion active · Reasoning enforced</span>
        <span style={{fontWeight:600,color:'#555'}}>One memory · Two surfaces</span>
      </footer>
    </div>
  );
}
