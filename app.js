/* ════════════════════════════════════════
   XRD PLOT TOOL V4 — app.js
════════════════════════════════════════ */
const PALETTE = ['#000000','#0072B2','#D55E00','#009E73','#CC79A7','#E69F00','#56B4E9','#F0E442','#555555','#884400','#0099bb','#44aa00','#6600cc','#999900'];
const ZOOM_PANE_COLORS = ['#2a5caa','#D55E00','#009E73','#CC79A7','#E69F00','#56B4E9','#884400'];
const SYMBOL_COLORS = {'★':'#D55E00','●':'#0072B2','■':'#009E73'};
const FONT = "'STIX Two Text', 'CMU Serif', Georgia, serif";

let datasets=[], annotations=[], magnifyRanges=[], dropLines=[];
let mainRange={from:20,to:80};
let hoverMode=false, magnifySelectMode=false, annotMode=false;
let colorPickerTarget=null, dragSrc=null, animFrame=null;
let tickConfig={bottom:true, top:true};
let xLabelText='2θ (°)', yLabelText='Intensity (a.u.)';
let smoothLevel=0;
let labelMode='stacked', labelSide='left';
let _G={xScale:null,offsets:null,vis:null,yScale:null,ph:0,mt:0,ml:0};
let editingAnnIdx = -1;
let interactiveXMin = null, interactiveXMax = null;
let stackAscending = true;
let plotAspectRatio = '16:9'; // '1:1','4:3','16:9','free'
let recentColors = [];
let pinchPreviewTimer = null;

/* ── GLOBAL BOUNDARY HELPERS ── */
function getGlobalXMin(){
    if(!datasets.length) return 0;
    return d3.min(datasets.flatMap(d=>d.data.map(p=>p.x)))||0;
}
function getGlobalXMax(){
    if(!datasets.length) return 80;
    return d3.max(datasets.flatMap(d=>d.data.map(p=>p.x)))||80;
}
function clampView(xMin,xMax){
    const gMin=getGlobalXMin(), gMax=getGlobalXMax();
    const span=xMax-xMin;
    if(span>=gMax-gMin) return {xMin:gMin,xMax:gMax};
    if(xMin<gMin){xMin=gMin;xMax=gMin+span;}
    if(xMax>gMax){xMax=gMax;xMin=gMax-span;}
    return {xMin:Math.max(gMin,xMin),xMax:Math.min(gMax,xMax)};
}

/* ── DATA PARSING (single X,Y file) ── */
function parseXY(text){
    const pts=[];
    for(const raw of text.split('\n')){
        const l=raw.trim();
        if(!l||/^[#!;]/.test(l)) continue;
        if(/^(2theta|2θ|theta|intensity|angle|counts|d-spacing)/i.test(l)) continue;
        const parts=l.split(/[\s,\t]+/);
        if(parts.length<2) continue;
        const x=parseFloat(parts[0]),y=parseFloat(parts[1]);
        if(isFinite(x)&&isFinite(y)) pts.push({x,y});
    }
    return pts;
}

/* ── MULTI-DATASET CSV PARSER ── */
function parseMultiCSV(text){
    const lines=text.split('\n').map(l=>l.trim()).filter(l=>l);
    if(lines.length<2) return null;
    const headerLine=lines[0];
    const headerParts=headerLine.split(/[,\t]+/);
    // Detect if header has non-numeric values (column names)
    const hasHeader=headerParts.some(h=>isNaN(parseFloat(h))&&h.length>0);
    if(!hasHeader||headerParts.length<4||headerParts.length%2!==0) return null;
    const nPairs=Math.floor(headerParts.length/2);
    const result=[];
    for(let p=0;p<nPairs;p++){
        const xName=headerParts[p*2].trim();
        const yName=headerParts[p*2+1].trim();
        const pts=[];
        for(let r=1;r<lines.length;r++){
            const cols=lines[r].split(/[,\t]+/);
            const x=parseFloat(cols[p*2]),y=parseFloat(cols[p*2+1]);
            if(isFinite(x)&&isFinite(y)) pts.push({x,y});
        }
        if(pts.length>1) result.push({name:yName||`Dataset ${p+1}`,data:pts});
    }
    return result.length>0?result:null;
}

/* ── ORIGINLAB-STYLE TEXT RENDERING ── */
function renderOriginText(parent,text,x,y,fontSize,fill,anchor){
    const group=parent.append('g').attr('transform',`translate(${x},${y})`);
    // Parse _(sub) and ^(sup) syntax
    const regex=/_(\([^)]*\))|\^(\([^)]*\))|([^_^]+)/g;
    let curX=0;const parts=[];let match;
    while((match=regex.exec(text))!==null){
        if(match[1]!==undefined) parts.push({text:match[1].slice(1,-1),type:'sub'});
        else if(match[2]!==undefined) parts.push({text:match[2].slice(1,-1),type:'sup'});
        else if(match[3]!==undefined) parts.push({text:match[3],type:'normal'});
    }
    if(parts.length===0) parts.push({text:text,type:'normal'});
    parts.forEach(p=>{
        const sz=p.type==='normal'?fontSize:fontSize*0.65;
        const dy=p.type==='sub'?fontSize*0.3:p.type==='sup'?-fontSize*0.35:0;
        const t=group.append('text').attr('x',curX).attr('y',dy).attr('font-size',sz).attr('fill',fill).attr('font-family',FONT).attr('font-weight',350).attr('dominant-baseline','middle').text(p.text);
        curX+=t.node().getComputedTextLength();
    });
    if(anchor==='middle') group.attr('transform',`translate(${x-curX/2},${y})`);
    else if(anchor==='end') group.attr('transform',`translate(${x-curX},${y})`);
    return group;
}
function normalise(pts){ const mx=d3.max(pts,d=>d.y)||1; return pts.map(d=>({x:d.x,y:d.y/mx})); }

/* ── SMOOTHING ── */
function smoothData(pts, level){
    if(level<=0||pts.length<3) return pts;
    const wins={5:3,10:7,20:15,35:25};
    const w=wins[level]||1;
    const hw=Math.floor(w/2);
    return pts.map((p,i)=>{
        let sum=0,cnt=0;
        for(let j=Math.max(0,i-hw);j<=Math.min(pts.length-1,i+hw);j++){ sum+=pts[j].y; cnt++; }
        return {x:p.x, y:sum/cnt};
    });
}

/* ── DEMO DATA ── */
function gauss(x,mu,s,a){return a*Math.exp(-0.5*((x-mu)/s)**2);}
function makePattern(peaks,noise=0.007){
    const pts=[];
    for(let x=20;x<=80;x+=0.02){ let y=noise*Math.random(); for(const[mu,s,a]of peaks) y+=gauss(x,mu,s,a); pts.push({x:+x.toFixed(2),y}); }
    return normalise(pts);
}
function loadDemo(){
    const defs=[
        {name:'ZrB₂',color:'#0072B2',peaks:[[25.2,.18,.35],[27.8,.15,1],[32.1,.17,.6],[39.5,.15,.55],[41.6,.14,.3],[48.9,.16,.45],[56.3,.15,.25],[67.4,.15,.2],[73.5,.16,.15]]},
        {name:'SiC',color:'#D55E00',peaks:[[35.6,.2,1],[38.1,.18,.3],[41.4,.17,.55],[60.0,.18,.45],[71.8,.17,.3]]},
        {name:'C',color:'#009E73',peaks:[[26.5,.15,1],[43.3,.14,.15],[44.5,.14,.18],[54.7,.15,.12]]},
    ];
    datasets=defs.map((d,i)=>({id:i,name:d.name,data:makePattern(d.peaks),color:d.color,visible:true,label:d.name}));
    annotations=[
        {x:27.8,label:'(101)',type:'text',dsId:0},{x:32.1,label:'(110)',type:'text',dsId:0},
        {x:35.6,label:'(111)',type:'text',dsId:1},{x:41.4,label:'(200)',type:'text',dsId:1},
        {x:26.5,label:'(002)',type:'text',dsId:2},
    ];
    magnifyRanges=[]; dropLines=[]; magnifyMarkers=[]; interactiveXMin=null; interactiveXMax=null;
    mainRange={from:getGlobalXMin(),to:getGlobalXMax()};
    document.getElementById('main-from').value=mainRange.from; document.getElementById('main-to').value=mainRange.to;
    magnifySelectMode=false; annotMode=false; updateModeButtons();
    updateSidebar(); renderMagnifyList(); renderDropList(); renderAnnList(); scheduleRedraw();
}

/* ── PEAK DETECTION ── */
function detectPeaks(data,windowSize=50,threshold=0.02){
    const peaks=[];
    if(data.length<windowSize*2) return peaks;
    for(let i=windowSize;i<data.length-windowSize;i++){
        let sumDx=0,sumDy=0,sumDxDy=0,sumDx2=0;
        for(let j=-windowSize;j<=windowSize;j++){const dx=j,dy=data[i+j].y-data[i].y;sumDx+=dx;sumDy+=dy;sumDxDy+=dx*dy;sumDx2+=dx*dx;}
        const n=2*windowSize+1;const slope=(n*sumDxDy-sumDx*sumDy)/(n*sumDx2-sumDx*sumDx);
        let slopeLeft=0,slopeRight=0;const hw=Math.floor(windowSize/2);
        for(let j=-hw;j<=0;j++) slopeLeft+=(data[i+j].y-data[i+j-1].y);
        for(let j=0;j<=hw;j++) slopeRight+=(data[i+j+1].y-data[i+j].y);
        slopeLeft/=hw; slopeRight/=hw;
        if(Math.abs(slope)<threshold*0.5&&slopeLeft>0.0001&&slopeRight<-0.0001&&data[i].y>threshold){
            let isMax=true;
            for(let j=Math.max(0,i-10);j<=Math.min(data.length-1,i+10);j++){if(data[j].y>data[i].y+0.001){isMax=false;break;}}
            if(isMax){const tooClose=peaks.some(p=>Math.abs(p.x-data[i].x)<0.5);if(!tooClose) peaks.push({x:data[i].x,y:data[i].y});}
        }
    }
    return peaks;
}

/* ── LATEX TEXT (kept for backward compat, delegates to OriginLab renderer) ── */
function renderLatexText(parent,text,x,y,fontSize,fill,anchor){
    return renderOriginText(parent,text,x,y,fontSize,fill,anchor);
}

/* ── DATASET SIDEBAR with mini graph icons ── */
function updateSidebar(){
    const list=document.getElementById('dataset-list'); list.innerHTML='';
    datasets.forEach((ds,idx)=>{
        const item=document.createElement('div'); item.className='dataset-item'; item.draggable=true;
        // Mini graph icon
        const iconWrap=document.createElement('div'); iconWrap.className='ds-icon';
        const miniSvg=document.createElementNS('http://www.w3.org/2000/svg','svg');
        miniSvg.setAttribute('viewBox','0 0 26 20'); miniSvg.setAttribute('preserveAspectRatio','none');
        const smData=ds.data;
        if(smData.length>2){
            const xExt=d3.extent(smData,d=>d.x), yExt=[0,d3.max(smData,d=>d.y)||1];
            const sx=d3.scaleLinear().domain(xExt).range([1,25]);
            const sy=d3.scaleLinear().domain(yExt).range([18,2]);
            let pathD='M';
            const step=Math.max(1,Math.floor(smData.length/24));
            for(let k=0;k<smData.length;k+=step) pathD+=`${sx(smData[k].x).toFixed(1)},${sy(smData[k].y).toFixed(1)} `;
            const path=document.createElementNS('http://www.w3.org/2000/svg','path');
            path.setAttribute('d',pathD); path.setAttribute('fill','none'); path.setAttribute('stroke',ds.color); path.setAttribute('stroke-width','1.5');
            miniSvg.appendChild(path);
        }
        iconWrap.appendChild(miniSvg);
        // Color swatch
        const swatch=document.createElement('div'); swatch.className='ds-swatch'; swatch.style.background=ds.color;
        swatch.addEventListener('click',e=>openColorPicker(e,ds.id));
        const nameWrap=document.createElement('div'); nameWrap.className='ds-name';
        const ni=document.createElement('input'); ni.type='text'; ni.value=ds.label;
        ni.addEventListener('change',e=>{ds.label=e.target.value;ds.name=e.target.value;scheduleRedraw();});
        nameWrap.appendChild(ni);
        const vis=document.createElement('span'); vis.className='ds-vis';
        vis.textContent=ds.visible?'👁':'○'; vis.title='Toggle';
        vis.addEventListener('click',()=>{ds.visible=!ds.visible;updateSidebar();scheduleRedraw();});
        const del=document.createElement('span'); del.className='ds-del'; del.textContent='×';
        del.addEventListener('click',()=>{datasets.splice(idx,1);updateSidebar();scheduleRedraw();});
        item.append(iconWrap,swatch,nameWrap,vis,del);
        item.addEventListener('dragstart',()=>{dragSrc=idx;item.classList.add('dragging');});
        item.addEventListener('dragend',()=>item.classList.remove('dragging'));
        item.addEventListener('dragover',e=>{e.preventDefault();item.classList.add('drag-over');});
        item.addEventListener('dragleave',()=>item.classList.remove('drag-over'));
        item.addEventListener('drop',e=>{e.preventDefault();item.classList.remove('drag-over');if(dragSrc!==null&&dragSrc!==idx){const m=datasets.splice(dragSrc,1)[0];datasets.splice(idx,0,m);updateSidebar();scheduleRedraw();}dragSrc=null;});
        list.appendChild(item);
    });
    const nv=datasets.filter(d=>d.visible).length;
    const np=datasets.reduce((s,d)=>s+d.data.length,0);
    document.getElementById('status').textContent=`${nv}/${datasets.length} visible · ${np.toLocaleString()} pts`;
    renderAnnList();
}

function renderMagnifyList(){
    const list=document.getElementById('magnify-list');if(!list)return;list.innerHTML='';
    if(!magnifyRanges.length){list.innerHTML='<div style="font-size:10.5px;color:var(--muted);">No magnified regions</div>';return;}
    magnifyRanges.forEach((zr,i)=>{
        const paneColor=ZOOM_PANE_COLORS[i%ZOOM_PANE_COLORS.length];
        const card=document.createElement('div');
        card.style.cssText=`border:1px solid ${paneColor}40;border-radius:5px;padding:6px 8px;background:${paneColor}08;`;
        // Header row: badge + delete
        const hdr=document.createElement('div');hdr.style.cssText='display:flex;align-items:center;justify-content:space-between;margin-bottom:5px;';
        const badge=document.createElement('span');badge.textContent=`M${i+1}`;badge.style.cssText=`color:${paneColor};font-weight:600;font-size:11px;`;
        const del=document.createElement('button');del.className='btn';del.textContent='×';del.style.cssText='padding:1px 5px;font-size:11px;';
        del.addEventListener('click',()=>{magnifyRanges.splice(i,1);renderMagnifyList();drawEmbeddedZoomPanes();scheduleRedraw();});
        hdr.append(badge,del);card.appendChild(hdr);
        // From/To editable inputs
        const inputRow=document.createElement('div');inputRow.style.cssText='display:flex;gap:4px;align-items:center;font-size:10px;';
        const fromLabel=document.createElement('span');fromLabel.textContent='From';fromLabel.style.color='var(--muted)';
        const fromInput=document.createElement('input');fromInput.type='number';fromInput.className='numinput';fromInput.value=zr.from.toFixed(1);fromInput.step='0.1';fromInput.style.width='52px';
        const toLabel=document.createElement('span');toLabel.textContent='To';toLabel.style.color='var(--muted)';
        const toInput=document.createElement('input');toInput.type='number';toInput.className='numinput';toInput.value=zr.to.toFixed(1);toInput.step='0.1';toInput.style.width='52px';
        const applyEdit=()=>{
            const f=parseFloat(fromInput.value),t=parseFloat(toInput.value);
            if(isFinite(f)&&isFinite(t)&&t>f){zr.from=f;zr.to=t;drawEmbeddedZoomPanes();scheduleRedraw();}
        };
        fromInput.addEventListener('change',applyEdit);
        toInput.addEventListener('change',applyEdit);
        inputRow.append(fromLabel,fromInput,toLabel,toInput);card.appendChild(inputRow);
        list.appendChild(card);
    });
}
function renderDropList(){
    const wrap=document.getElementById('drop-list');if(!wrap)return;wrap.innerHTML='';
    if(!dropLines.length){wrap.innerHTML='<div style="font-size:10.5px;color:var(--muted);">No lines</div>';return;}
    dropLines.forEach((dx,i)=>{
        const row=document.createElement('div');row.style.cssText='display:flex;align-items:center;gap:6px;font-size:11px;';
        const val=document.createElement('span');val.textContent=`${dx.toFixed(2)}°`;val.style.flex='1';
        const del=document.createElement('button');del.className='btn';del.textContent='×';del.style.cssText='padding:2px 6px;';
        del.addEventListener('click',()=>{dropLines.splice(i,1);renderDropList();scheduleRedraw();});
        row.append(val,del);wrap.appendChild(row);
    });
}
function renderAnnList(){
    const al=document.getElementById('ann-list');if(!al)return;al.innerHTML='';
    if(!annotations.length){al.innerHTML='<div style="font-size:10.5px;color:var(--muted);">No annotations</div>';return;}
    annotations.forEach((a,i)=>{
        const row=document.createElement('div');row.className='ann-row';
        const labelWrap=document.createElement('div');labelWrap.className='ann-label';
        const ds=datasets.find(d=>d.id===a.dsId);
        const col=ds?ds.color:'#888';
        labelWrap.innerHTML=`<span style="color:${col};font-weight:500;">${a.x.toFixed(1)}°</span> <strong>${a.label||''}</strong>`;
        const editBtn=document.createElement('button');editBtn.className='ann-edit-btn';editBtn.textContent='✎';editBtn.title='Edit';
        editBtn.addEventListener('click',()=>openAnnEditor(i));
        const del=document.createElement('button');del.className='btn';del.textContent='×';del.style.cssText='padding:2px 5px;font-size:10px;';
        del.addEventListener('click',()=>{annotations.splice(i,1);if(editingAnnIdx===i){editingAnnIdx=-1;document.getElementById('ann-editor-section').style.display='none';}renderAnnList();scheduleRedraw();});
        row.append(labelWrap,editBtn,del);al.appendChild(row);
    });
}
function openAnnEditor(idx){
    editingAnnIdx=idx;
    const a=annotations[idx];
    const sec=document.getElementById('ann-editor-section');sec.style.display='block';
    const ed=document.getElementById('ann-editor');
    ed.innerHTML=`
        <div class="ae-field"><label>Label</label><input type="text" id="ae-label" value="${a.label||''}"></div>
        <div class="ae-field"><label>2θ Position</label><input type="number" id="ae-pos" value="${a.x.toFixed(3)}" step="0.01"></div>
        <div class="ae-field"><label>Dataset</label><select id="ae-ds">${datasets.map(d=>`<option value="${d.id}" ${d.id===a.dsId?'selected':''}>${d.label}</option>`).join('')}</select></div>
        <button class="btn primary" id="ae-apply" style="width:100%;margin-top:6px;">Apply</button>`;
    document.getElementById('ae-apply').addEventListener('click',()=>{
        a.label=document.getElementById('ae-label').value;
        a.x=parseFloat(document.getElementById('ae-pos').value);
        a.dsId=parseFloat(document.getElementById('ae-ds').value)||a.dsId;
        renderAnnList();scheduleRedraw();
    });
}

function updateModeButtons(){
    const zb=document.getElementById('magnify-mode-btn'),ab=document.getElementById('ann-mode-btn');
    zb.classList.toggle('active',magnifySelectMode);zb.textContent=magnifySelectMode?'⬚ Magnify ON':'⬚ Magnify';
    ab.classList.toggle('active',annotMode);ab.textContent=annotMode?'+ Annotate ON':'+ Annotate';
    // Mouse button is active when no other mode is on
    const mouseBtn=document.getElementById('mouse-btn');
    if(mouseBtn) mouseBtn.classList.toggle('active',!hoverMode&&!magnifySelectMode&&!annotMode);
}

/* ── PPT-STYLE COLOR PICKER ── */
const PPT_THEME=['#FFFFFF','#000000','#E7E6E6','#44546A','#4472C4','#ED7D31','#A5A5A5','#FFC000','#5B9BD5','#70AD47',
'#F2F2F2','#7F7F7F','#D0CECE','#D6DCE4','#D9E2F3','#FCE4CC','#EDEDED','#FFF2CC','#DEEBF6','#E2EFDA',
'#D8D8D8','#595959','#AEAAAA','#ADB9CA','#B4C6E7','#F8CAAA','#DBDBDB','#FFE699','#BDD7EE','#C5E0B3',
'#BFBFBF','#3F3F3F','#757070','#8496B0','#8EAADB','#F4B183','#C9C9C9','#FFD966','#9CC3E5','#A8D08D',
'#A5A5A5','#262626','#3B3838','#323F4F','#2F5496','#C45911','#7B7B7B','#BF9000','#2E75B6','#538135',
'#7F7F7F','#0C0C0C','#171616','#222A35','#1F3864','#833C0B','#525252','#7F6000','#1F4E79','#375623'];
const PPT_STANDARD=['#C00000','#FF0000','#FFC000','#FFFF00','#92D050','#00B050','#00B0F0','#0070C0','#002060','#7030A0'];
function buildColorGrid(){
    const tg=document.getElementById('ppt-theme-grid');tg.innerHTML='';
    PPT_THEME.forEach(c=>{const d=document.createElement('div');d.className='ppt-color-cell';d.style.background=c;d.title=c;
    d.addEventListener('click',()=>applyColor(c));d.addEventListener('mouseenter',()=>{document.getElementById('ppt-preview-swatch').style.background=c;});tg.appendChild(d);});
    const sg=document.getElementById('ppt-standard-grid');sg.innerHTML='';
    PPT_STANDARD.forEach(c=>{const d=document.createElement('div');d.className='ppt-color-cell';d.style.background=c;d.title=c;
    d.addEventListener('click',()=>applyColor(c));d.addEventListener('mouseenter',()=>{document.getElementById('ppt-preview-swatch').style.background=c;});sg.appendChild(d);});
    updateRecentColors();
}
function updateRecentColors(){
    const rg=document.getElementById('ppt-recent-grid');if(!rg)return;rg.innerHTML='';
    if(!recentColors.length){rg.innerHTML='<div class="ppt-empty-recent">None</div>';return;}
    recentColors.forEach(c=>{const d=document.createElement('div');d.className='ppt-color-cell';d.style.background=c;d.title=c;
    d.addEventListener('click',()=>applyColor(c));rg.appendChild(d);});
}
function openColorPicker(e,dsId){colorPickerTarget=dsId;const p=document.getElementById('color-picker');p.style.display='block';p.style.left=(e.clientX+10)+'px';p.style.top=(e.clientY-10)+'px';const ds=datasets.find(d=>d.id===dsId);if(ds){document.getElementById('ppt-hex-input').value=ds.color;document.getElementById('ppt-preview-swatch').style.background=ds.color;}}
function applyColor(c){
    const ds=datasets.find(d=>d.id===colorPickerTarget);
    if(ds){ds.color=c;if(!recentColors.includes(c)){recentColors.unshift(c);if(recentColors.length>10)recentColors.pop();}updateRecentColors();updateSidebar();scheduleRedraw();}
    document.getElementById('color-picker').style.display='none';
}

function scheduleRedraw(skipForce){if(animFrame)cancelAnimationFrame(animFrame);if(!skipForce)draw._force=true;animFrame=requestAnimationFrame(draw);}

/* ════════════════════════════════════════
   MAIN DRAW FUNCTION
════════════════════════════════════════ */
let _lastDrawW=0, _lastDrawH=0;
function draw(){
    const container=document.getElementById('plot-container');
    let totalW=container.clientWidth, H=container.clientHeight;
    // Skip if dimensions haven't changed (breaks resize-redraw loops)
    if(totalW===_lastDrawW && H===_lastDrawH && !draw._force){ return; }
    _lastDrawW=totalW; _lastDrawH=H; draw._force=false;
    if(totalW<80||H<80) return;

    // Enforce aspect ratio on the PLOT REGION only (shrink-to-fit, never grow)
    const ml=50, mr=20, mt=20, mb=50;
    let pw=totalW-ml-mr, ph=H-mt-mb;
    if(plotAspectRatio!=='free'){
        const [rw,rh]=plotAspectRatio.split(':').map(Number);
        const targetRatio=rw/rh;
        const currentRatio=pw/ph;
        // Only shrink the dimension that's too large, never grow
        if(currentRatio>targetRatio){ pw=Math.round(ph*targetRatio); }
        else if(currentRatio<targetRatio){ ph=Math.round(pw/targetRatio); }
    }
    if(pw<50) pw=50; if(ph<50) ph=50;
    const mainW=pw+ml+mr;
    const mainH=Math.min(H,ph+mt+mb); // never exceed container height

    const vis=datasets.filter(d=>d.visible);
    const lineW=parseFloat(document.getElementById('line-width').value);
    const stackOff=parseFloat(document.getElementById('stack-offset').value);
    if(vis.length===0){d3.select('#main-svg').selectAll('*').remove();return;}

    // Global boundary-aware range
    const gMin=getGlobalXMin(), gMax=getGlobalXMax();
    const useMain=mainRange&&isFinite(mainRange.from)&&isFinite(mainRange.to)&&mainRange.to>mainRange.from;
    let xMin=interactiveXMin!==null?interactiveXMin:(useMain?mainRange.from:gMin);
    let xMax=interactiveXMax!==null?interactiveXMax:(useMain?mainRange.to:gMax);
    // Clamp to global boundaries
    const clamped=clampView(xMin,xMax);
    xMin=clamped.xMin; xMax=clamped.xMax;
    if(xMax<=xMin) xMax=xMin+1;
    const xScale=d3.scaleLinear().domain([xMin,xMax]).range([0,pw]);
    const offsets=vis.map((_,i)=>i*stackOff);
    const totalYMax=(offsets[offsets.length-1]||0)+1.15;
    const yScale=d3.scaleLinear().domain([0,totalYMax]).range([ph,0]);

    const allXMin=gMin, allXMax=gMax;
    _G={xScale,offsets,vis,yScale,ph,mt,ml,pw,xMin,xMax,totalYMax,allXMin,allXMax};

    const mainSvg=d3.select('#main-svg').attr('width',mainW).attr('height',mainH).style('background','#fff');
    mainSvg.selectAll('*').remove();
    const g=mainSvg.append('g').attr('transform',`translate(${ml},${mt})`);
    g.append('clipPath').attr('id','plot-clip').append('rect').attr('width',pw).attr('height',ph);

    /* ── GRAPH PAPER (auto-scaling) ── */
    drawGraphPaper(g,pw,ph,xScale,yScale);

    /* ── MAGNIFY REGION HIGHLIGHTS (unique color per pane) ── */
    magnifyRanges.forEach((zr,idx)=>{
        const hc=ZOOM_PANE_COLORS[idx%ZOOM_PANE_COLORS.length];
        const rx1=xScale(zr.from),rx2=xScale(zr.to);
        g.append('rect').attr('x',rx1).attr('y',0)
            .attr('width',Math.max(0,rx2-rx1)).attr('height',ph)
            .attr('fill',hc).attr('fill-opacity',0.1).attr('stroke',hc).attr('stroke-opacity',0.5)
            .attr('stroke-width',1.5).attr('stroke-dasharray','6,3');
    });

    /* ── DROP LINES ── */
    dropLines.forEach(dx=>{
        const xx=xScale(dx);
        if(xx>=-5&&xx<=pw+5) g.append('line').attr('x1',xx).attr('y1',0).attr('x2',xx).attr('y2',ph).attr('stroke','#d2791a').attr('stroke-width',1.2).attr('stroke-dasharray','5,4');
    });

    /* ── DATA LINES (CrystalMaker-style) ── */
    const visSpan=xMax-xMin;
    vis.forEach((ds,i)=>{
        const offset=offsets[i];
        const raw=ds.data;
        const sm=smoothData(raw,smoothLevel);
        const line=d3.line().x(d=>xScale(d.x)).y(d=>yScale(d.y+offset)).curve(d3.curveLinear).defined(d=>isFinite(d.y));
        g.append('path').datum(sm).attr('fill','none').attr('stroke',ds.color).attr('stroke-width',lineW)
            .attr('clip-path','url(#plot-clip)').attr('d',line);
    });

    /* ── TEXT ANNOTATIONS (stable: skip if dataset hidden, don't fallback) ── */
    annotations.filter(a=>a.type!=='symbol').forEach(a=>{
        const ds=datasets.find(d=>d.id===a.dsId);
        if(!ds) return; // dataset deleted entirely
        if(!ds.visible) return; // hidden → skip, don't shift
        const visIdx=vis.indexOf(ds);
        if(visIdx<0) return;
        const offset=offsets[visIdx];
        const xi=xScale(a.x); if(xi<-5||xi>pw+5) return;
        const sm=smoothData(ds.data,smoothLevel);
        const closest=sm.reduce((b,p)=>Math.abs(p.x-a.x)<Math.abs(b.x-a.x)?p:b,sm[0]);
        const yi=yScale(closest.y+offset);
        const yText=Math.max(18,yi-16);
        g.append('line').attr('x1',xi).attr('y1',yi-2).attr('x2',xi).attr('y2',yText+2).attr('stroke','#555').attr('stroke-width',.6);
        g.append('text').attr('x',xi).attr('y',yText).attr('text-anchor','middle')
            .attr('font-size',16).attr('fill',ds.color).attr('font-family',FONT).attr('font-weight',350).text(a.label||'peak');
    });

    /* ── SYMBOL ANNOTATIONS ── */
    const symAnns=annotations.filter(a=>a.type==='symbol');
    symAnns.forEach(a=>{
        const ds=datasets.find(d=>d.id===a.dsId);
        if(!ds||!ds.visible) return;
        const visIdx=vis.indexOf(ds); if(visIdx<0) return;
        const offset=offsets[visIdx];
        const xi=xScale(a.x); if(xi<-5||xi>pw+5) return;
        const sm=smoothData(ds.data,smoothLevel);
        const closest=sm.reduce((b,p)=>Math.abs(p.x-a.x)<Math.abs(b.x-a.x)?p:b,sm[0]);
        const yi=yScale(closest.y+offset);
        g.append('text').attr('x',xi).attr('y',yi-12).attr('text-anchor','middle')
            .attr('font-size',22).attr('fill',SYMBOL_COLORS[a.symbol]||'#333').text(a.symbol);
    });

    /* ── DATASET LABELS (simplified) ── */
    if(labelMode==='stacked'){
        const perRow=vis.length>4?Math.ceil(vis.length/2):vis.length;
        vis.forEach((ds,idx)=>{
            const row=Math.floor(idx/perRow),col=idx%perRow;
            const xPos=pw*(col+1)/(perRow+1), yPos=14+row*16;
            g.append('text').attr('x',xPos).attr('y',yPos).attr('font-size',13).attr('fill',ds.color)
                .attr('font-family',FONT).attr('font-weight',500).attr('text-anchor','middle').text(ds.label);
        });
    } else {
        const onLeft=labelSide==='left';
        vis.forEach((ds,idx)=>{
            const yVal=yScale(offsets[idx]+0.5);
            g.append('text').attr('x',onLeft?8:pw-8).attr('y',yVal).attr('font-size',13).attr('fill',ds.color)
                .attr('font-family',FONT).attr('font-weight',500).attr('dominant-baseline','middle')
                .attr('text-anchor',onLeft?'start':'end').text(ds.label);
        });
    }

    /* ── AXES: bottom outside, top inside, NO y-axis ticks, keep border ── */
    const tickSize=6, tickLabelSize=14, axisTitleSize=18;
    if(tickConfig.bottom){
        g.append('g').attr('transform',`translate(0,${ph})`)
            .call(d3.axisBottom(xScale).ticks(8).tickSize(tickSize))
            .call(ax=>{ax.selectAll('text').attr('font-family',FONT).attr('font-size',tickLabelSize).attr('font-weight',350);ax.select('.domain').remove();});
    }
    if(tickConfig.top){
        g.append('g').call(d3.axisTop(xScale).ticks(8).tickSize(-tickSize))
            .call(ax=>{ax.selectAll('text').remove();ax.select('.domain').remove();});
    }
    // Border rectangle (no y-axis ticks, just the box)
    g.append('rect').attr('x',0).attr('y',0).attr('width',pw).attr('height',ph)
        .attr('fill','none').attr('stroke','#333').attr('stroke-width',1.5);

    /* ── INTERACTION OVERLAY ── */
    const overlay=g.append('rect').attr('x',0).attr('y',0).attr('width',pw).attr('height',ph)
        .attr('fill','transparent').style('cursor',magnifySelectMode?'crosshair':annotMode?'copy':hoverMode?'crosshair':'default');
    overlay.on('contextmenu.dropline',ev=>{ev.preventDefault();dropLines.push(_G.xScale.invert(d3.pointer(ev)[0]));renderDropList();scheduleRedraw();});
    if(magnifySelectMode) setupMagnifyDrag(overlay,g,pw,ph);
    else if(annotMode) setupAnnotClick(overlay,g);
    else if(hoverMode) setupHover(overlay,g,pw,ph);

    /* ── AXIS LABELS ── */
    const xLabelEl=renderLatexText(mainSvg,xLabelText,ml+pw/2,mainH-6,axisTitleSize,'#111','middle');
    xLabelEl.style('cursor','pointer').on('click',()=>startAxisEdit('x'));


    /* ── EMBEDDED ZOOM PANES (right magnification workspace) ── */
    drawEmbeddedZoomPanes();
}

/* ── GRAPH PAPER (auto-scaling grid) ── */
function drawGraphPaper(g,pw,ph,xScale,yScale){
    const gridG=g.append('g').attr('class','graph-paper');
    const [xMin,xMax]=xScale.domain();
    const xSpan=xMax-xMin;
    // Pick nice major interval: largest of [0.1,0.2,0.5,1,2,5,10] that gives ≥4 major divisions
    const niceSteps=[0.1,0.2,0.5,1,2,5,10];
    let majorStep=1;
    for(let k=niceSteps.length-1;k>=0;k--){if(xSpan/niceSteps[k]>=4){majorStep=niceSteps[k];break;}}
    const minorStep=majorStep/5;
    // Vertical grid lines
    const startX=Math.ceil(xMin/minorStep)*minorStep;
    for(let v=startX;v<=xMax;v+=minorStep){
        const x=xScale(v); if(x<0||x>pw) continue;
        const isMajor=Math.abs(v/majorStep-Math.round(v/majorStep))<0.01;
        gridG.append('line').attr('x1',x).attr('y1',0).attr('x2',x).attr('y2',ph)
            .attr('stroke',isMajor?'#ddd':'#f0f0f0').attr('stroke-width',isMajor?0.8:0.4);
    }
    // Horizontal grid: make squares matching the x-axis major grid
    const pxPerMajor=Math.abs(xScale(majorStep)-xScale(0));
    if(pxPerMajor>5){
        const hMinor=pxPerMajor/5;
        for(let y=0;y<=ph;y+=hMinor){
            const isMajor=Math.abs(y%(pxPerMajor)-0)<1;
            gridG.append('line').attr('x1',0).attr('y1',y).attr('x2',pw).attr('y2',y)
                .attr('stroke',isMajor?'#ddd':'#f0f0f0').attr('stroke-width',isMajor?0.8:0.4);
        }
    }
}



/* ── MAGNIFY DRAG SELECTION ── */
function setupMagnifyDrag(overlay,g,pw,ph){
    let dragStart=null;
    const rulerEl=document.getElementById('ruler-overlay'),rulerLabel=document.getElementById('ruler-label'),container=document.getElementById('plot-container');
    overlay
        .on('mousedown.magnify',ev=>{ev.preventDefault();const[mx]=d3.pointer(ev);dragStart={px:mx,val:_G.xScale.invert(mx)};})
        .on('mousemove.magnify',ev=>{
            if(!dragStart)return;const[mx]=d3.pointer(ev);const curVal=_G.xScale.invert(mx);
            const x1=Math.min(dragStart.px,mx),x2=Math.max(dragStart.px,mx);const delta=Math.abs(curVal-dragStart.val);
            g.selectAll('.drag-magnify-box').remove();
            g.append('rect').attr('class','drag-magnify-box').attr('x',x1).attr('y',0).attr('width',x2-x1).attr('height',ph)
                .attr('fill','rgba(42,92,170,0.18)').attr('stroke','rgba(42,92,170,0.8)').attr('stroke-width',2).attr('pointer-events','none');
            const rect=container.getBoundingClientRect();
            rulerEl.style.display='block';rulerEl.style.left=(rect.left+_G.ml+x1)+'px';rulerEl.style.top=(rect.top+_G.mt)+'px';
            rulerEl.style.width=Math.max(1,x2-x1)+'px';rulerEl.style.height=ph+'px';
            rulerLabel.textContent=`Δ(2θ) = ${delta.toFixed(2)}°`;
        })
        .on('mouseup.magnify',ev=>{
            if(!dragStart)return;const[mx]=d3.pointer(ev);const endVal=_G.xScale.invert(mx);
            const x1=Math.min(dragStart.val,endVal),x2=Math.max(dragStart.val,endVal);
            dragStart=null;g.selectAll('.drag-magnify-box').remove();rulerEl.style.display='none';
            if(x2-x1>0.1){
                const paneColor=ZOOM_PANE_COLORS[magnifyRanges.length%ZOOM_PANE_COLORS.length];
                magnifyRanges.push({from:x1,to:x2,color:paneColor,annotations:[],markers:[]});
                renderMagnifyList();drawEmbeddedZoomPanes();scheduleRedraw();showNavPreview();
            }
        })
        .on('mouseleave.magnify',()=>{dragStart=null;g.selectAll('.drag-magnify-box').remove();rulerEl.style.display='none';});
}

/* ── ANNOTATION CLICK ── */
function setupAnnotClick(overlay,g){
    overlay.on('click.annot',ev=>{ev.stopPropagation();ev.preventDefault();const[mx]=d3.pointer(ev);showAnnotationPopover(ev,_G.xScale.invert(mx));});
}
function showAnnotationPopover(ev,xVal){
    const pop=document.getElementById('annotation-popover');
    pop.style.display='block';pop.style.left=(ev.clientX+10)+'px';pop.style.top=(ev.clientY-10)+'px';
    // Find nearest peak using hover logic
    let bestPeak=null,bestDist=Infinity;
    const vis=_G.vis||[];
    vis.forEach(ds=>{
        const sm=smoothData(ds.data,smoothLevel);
        sm.forEach(p=>{if(Math.abs(p.x-xVal)<bestDist){bestDist=Math.abs(p.x-xVal);bestPeak={x:p.x,y:p.y,dsId:ds.id};}});
    });
    const snapX=bestPeak&&bestDist<1?bestPeak.x:xVal;
    const snapDsId=bestPeak?bestPeak.dsId:(datasets.length>0?datasets[0].id:0);
    pop.innerHTML=`
    <h4>Annotate at ${snapX.toFixed(2)}°</h4>
    <input type="text" id="pop-label" placeholder="Label (e.g. (101))">
    <div style="margin:6px 0 4px;font-size:10px;color:var(--muted);">Or symbol:</div>
    <div class="symbol-picker">
      <div class="symbol-btn" data-sym="★" style="color:#D55E00;">★</div>
      <div class="symbol-btn" data-sym="●" style="color:#0072B2;">●</div>
      <div class="symbol-btn" data-sym="■" style="color:#009E73;">■</div>
    </div>
    <div style="margin:4px 0;font-size:9px;color:var(--muted);">Dataset:</div>
    <select id="pop-ds" style="width:100%;font-size:10px;padding:2px;margin-bottom:6px;">${datasets.map(d=>`<option value="${d.id}" ${d.id===snapDsId?'selected':''}>${d.label}</option>`).join('')}</select>
    <div style="display:flex;gap:5px;">
      <button class="btn primary" id="pop-add-text" style="flex:1;">Add</button>
      <button class="btn" id="pop-cancel">Cancel</button>
    </div>`;
    pop.querySelectorAll('.symbol-btn').forEach(btn=>{
        btn.addEventListener('click',()=>{
            const sym=btn.dataset.sym;const dsId=parseFloat(document.getElementById('pop-ds').value)||snapDsId;
            annotations.push({x:snapX,label:sym,type:'symbol',symbol:sym,dsId});renderAnnList();scheduleRedraw();pop.style.display='none';
        });
    });
    document.getElementById('pop-add-text').addEventListener('click',()=>{
        const label=document.getElementById('pop-label').value||'peak';
        const dsId=parseFloat(document.getElementById('pop-ds').value)||snapDsId;
        annotations.push({x:snapX,label,type:'text',dsId});renderAnnList();scheduleRedraw();pop.style.display='none';
    });
    document.getElementById('pop-cancel').addEventListener('click',()=>{pop.style.display='none';});
}

/* ── HOVER INSPECTOR (with click-to-annotate) ── */
function setupHover(overlay,g,pw,ph){
    overlay
        .on('mousemove.hover',ev=>{
            const{xScale,offsets,vis,yScale}=_G;if(!xScale)return;
            const[mx]=d3.pointer(ev);const xVal=xScale.invert(mx);
            g.selectAll('.ch-v,.ch-dot').remove();
            g.append('line').attr('class','ch-v').attr('x1',mx).attr('y1',0).attr('x2',mx).attr('y2',ph)
                .attr('stroke','rgba(60,60,60,0.5)').attr('stroke-width',.8).attr('stroke-dasharray','3,3').attr('pointer-events','none');
            const rows=[];
            vis.forEach((ds,i)=>{
                const data=smoothData(ds.data,smoothLevel);if(!data.length)return;
                let lo=0,hi=data.length-1;
                while(lo<hi){const mid=(lo+hi)>>1;if(data[mid].x<xVal)lo=mid+1;else hi=mid;}
                if(lo>0&&Math.abs(data[lo-1].x-xVal)<Math.abs(data[lo].x-xVal))lo--;
                const start=Math.max(0,lo-30),end=Math.min(data.length-1,lo+30);
                let peak=null;
                for(let j=start;j<=end;j++){if(Math.abs(data[j].x-xVal)<=0.6&&(!peak||data[j].y>peak.y))peak=data[j];}
                const pt=peak||data[lo];
                const ypx=yScale(pt.y+offsets[i]);
                g.append('circle').attr('class','ch-dot').attr('cx',xScale(pt.x)).attr('cy',ypx).attr('r',4)
                    .attr('fill',ds.color).attr('stroke','white').attr('stroke-width',1.5).attr('pointer-events','none');
                rows.push(`<span style="color:${ds.color};font-weight:500;">${ds.label.slice(0,22)}</span><br><span style="color:#ccc;">&nbsp;2θ&nbsp;</span><b>${pt.x.toFixed(4)}°</b>&ensp;<span style="color:#ccc;">I&nbsp;</span><b>${pt.y.toFixed(5)}</b>`);
            });
            const tt=document.getElementById('xrd-tooltip');tt.style.display='block';
            tt.innerHTML=`<div style="color:#aaa;font-size:9.5px;margin-bottom:4px;">cursor: ${xVal.toFixed(3)}° <span style="color:#6af;">click to annotate</span></div>`+rows.join('<div style="border-top:1px solid rgba(255,255,255,0.08);margin:3px 0;"></div>');
            tt.style.left=(ev.clientX+(ev.clientX+230>window.innerWidth?-240:15))+'px';
            tt.style.top=(ev.clientY+(ev.clientY+80>window.innerHeight?-80:10))+'px';
        })
        .on('mouseleave.hover',()=>{d3.selectAll('.ch-v,.ch-dot').remove();document.getElementById('xrd-tooltip').style.display='none';})
        .on('click.hover',ev=>{
            // Click-to-annotate in hover mode: snap to nearest peak
            const[mx]=d3.pointer(ev);const xVal=_G.xScale.invert(mx);
            showAnnotationPopover(ev,xVal);
        });
}

/* ── AXIS EDITING ── */
function startAxisEdit(axis){
    const container=document.getElementById('plot-container'),rect=container.getBoundingClientRect();
    const input=document.createElement('input');input.className='axis-edit-input';
    input.value=axis==='x'?xLabelText:yLabelText;
    if(axis==='x'){input.style.left=(rect.left+rect.width/2-80)+'px';input.style.top=(rect.bottom-30)+'px';}
    else{input.style.left=(rect.left-40)+'px';input.style.top=(rect.top+rect.height/2-15)+'px';}
    input.style.position='fixed';document.body.appendChild(input);input.focus();input.select();
    const finish=()=>{if(axis==='x')xLabelText=input.value;else yLabelText=input.value;input.remove();scheduleRedraw();};
    input.addEventListener('blur',finish);input.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();finish();}});
}

/* ── EMBEDDED ZOOM PANES (right magnification workspace) ── */
function drawEmbeddedZoomPanes(){
    const workspace=document.getElementById('magnify-workspace');
    const container=document.getElementById('zoom-panes-container');
    const emptyEl=document.getElementById('mw-empty');
    container.innerHTML='';
    const vis=datasets.filter(d=>d.visible);

    if(!magnifyRanges.length||!vis.length){
        workspace.style.width='0px';workspace.style.minWidth='0px';workspace.classList.remove('open');
        if(emptyEl)emptyEl.style.display='block';
        return;
    }
    // Calculate workspace width from largest pane
    const lineW=parseFloat(document.getElementById('line-width').value)||1.2;
    const stackOff=parseFloat(document.getElementById('stack-offset').value)||1.2;
    const offsets=vis.map((_,i)=>i*stackOff);
    const totalYMax=(offsets[offsets.length-1]||0)+1.15;
    // Stable parent height for WORKSPACE WIDTH calculation (prevents oscillation)
    const stableH=document.querySelector('.plot-and-workspace').clientHeight||500;
    const stableGraphH=Math.max(200,stableH-70);
    // Actual pane graph height matches main XRD plot
    const paneH=_G.ph||stableGraphH;

    // Fixed workspace width: based on 2:5 graph (widest) + 5% label padding each side + axis margins
    const maxGraphW=Math.max(160,Math.round(stableGraphH*(2/5))); // use stable height for width calc
    const labelPad=Math.round(maxGraphW*0.05); // 5% padding each side for labels
    const axisMargin=30; // left+right axis margins
    const fixedCardInner=maxGraphW+labelPad*2+axisMargin;
    const workspaceW=fixedCardInner+16; // +padding for panel
    workspace.style.width=workspaceW+'px';workspace.style.minWidth=workspaceW+'px';workspace.classList.add('open');
    if(emptyEl)emptyEl.style.display='none';

    magnifyRanges.forEach((zr,idx)=>{
        const span=zr.to-zr.from;if(!(isFinite(span)&&span>0))return;
        const paneColor=ZOOM_PANE_COLORS[idx%ZOOM_PANE_COLORS.length];
        // Auto aspect: <2° → 0.5:5, 2–10° → 1:5, >10° → 2:5
        const aspectW=span<2?0.5:(span<=10?1:2), aspectH=5;
        const zph=paneH;
        const zpw=Math.max(80,Math.round(zph*(aspectW/aspectH)));
        // Card always fills workspace width; graph is centered within it
        const cardW=fixedCardInner;
        const zml=Math.round((cardW-zpw)/2); // center the graph horizontally
        const zmr=cardW-zpw-zml;
        const zmt=4,zmb=24;
        const cardH=zph+zmt+zmb;

        const card=document.createElement('div');card.className='zoom-pane-card';
        card.style.borderColor=paneColor+'60';
        // Header
        const header=document.createElement('div');header.className='zoom-pane-header';
        header.style.borderBottomColor=paneColor+'40';
        const rangeLabel=document.createElement('span');rangeLabel.className='zp-range';
        rangeLabel.textContent=`M${idx+1}: ${zr.from.toFixed(1)}–${zr.to.toFixed(1)}° (Δ=${span.toFixed(1)}°)`;
        rangeLabel.style.color=paneColor;
        const closeBtn=document.createElement('button');closeBtn.className='zp-close';closeBtn.textContent='×';
        closeBtn.addEventListener('click',()=>{magnifyRanges.splice(idx,1);renderMagnifyList();drawEmbeddedZoomPanes();scheduleRedraw();});
        header.append(rangeLabel,closeBtn);card.appendChild(header);
        // SVG — full card width, graph centered via zml offset
        const svgEl=document.createElementNS('http://www.w3.org/2000/svg','svg');
        svgEl.setAttribute('width',cardW);svgEl.setAttribute('height',cardH);
        svgEl.setAttribute('class','zoom-pane-svg');svgEl.style.background='#fff';
        card.appendChild(svgEl);

        const svg=d3.select(svgEl);
        const xz=d3.scaleLinear().domain([zr.from,zr.to]).range([0,zpw]);
        const yz=d3.scaleLinear().domain([0,totalYMax]).range([zph,0]);
        const gz=svg.append('g').attr('transform',`translate(${zml},${zmt})`);
        gz.append('clipPath').attr('id',`zc-${idx}`).append('rect').attr('width',zpw).attr('height',zph);
        // No graph paper in zoomed panes — clean white background

        // Drop lines
        dropLines.forEach(dx=>{if(dx>=zr.from&&dx<=zr.to)gz.append('line').attr('x1',xz(dx)).attr('y1',0).attr('x2',xz(dx)).attr('y2',zph).attr('stroke','#d2791a').attr('stroke-width',1.2).attr('stroke-dasharray','5,4');});

        // Vertical markers for this pane
        if(!zr.markers) zr.markers=[];
        zr.markers.forEach(mk=>{
            gz.append('line').attr('x1',xz(mk)).attr('y1',0).attr('x2',xz(mk)).attr('y2',zph)
                .attr('stroke','#e44').attr('stroke-width',1).attr('stroke-dasharray','4,3');
            gz.append('text').attr('x',xz(mk)).attr('y',zph+12).attr('text-anchor','middle').attr('font-size',8).attr('fill','#e44').attr('font-family',FONT).text(mk.toFixed(2)+'°');
        });

        // Data traces
        vis.forEach((ds,i)=>{
            const all=smoothData(ds.data,smoothLevel);
            const iFrom=Math.max(0,d3.bisectLeft(all.map(p=>p.x),zr.from)-1);
            const iTo=Math.min(all.length-1,d3.bisectRight(all.map(p=>p.x),zr.to));
            const subset=all.slice(iFrom,iTo+1);
            const line=d3.line().x(d=>xz(d.x)).y(d=>yz(d.y+offsets[i])).curve(d3.curveLinear).defined(d=>isFinite(d.y));
            gz.append('path').datum(subset).attr('fill','none').attr('stroke',ds.color).attr('stroke-width',lineW).attr('clip-path',`url(#zc-${idx})`).attr('d',line);
        });

        // Pane-isolated annotations
        if(zr.annotations&&zr.annotations.length){
            zr.annotations.forEach(a=>{
                const xi=xz(a.x);if(xi<0||xi>zpw)return;
                gz.append('line').attr('x1',xi).attr('y1',0).attr('x2',xi).attr('y2',14).attr('stroke',paneColor).attr('stroke-width',0.8);
                gz.append('text').attr('x',xi).attr('y',12).attr('text-anchor','middle').attr('font-size',9).attr('fill',paneColor).attr('font-family',FONT).attr('font-weight',500).text(a.label);
            });
        }

        // Axes — exactly 3 labels: left, center, right
        const tickVals=[zr.from, (zr.from+zr.to)/2, zr.to];
        gz.append('g').attr('transform',`translate(0,${zph})`).call(d3.axisBottom(xz).tickValues(tickVals).tickFormat(d=>d.toFixed(1)+'°').tickSize(5)).call(ax=>{ax.selectAll('text').attr('font-size',10).attr('font-family',FONT).attr('font-weight',350);ax.select('.domain').remove();});
        gz.append('g').call(d3.axisTop(xz).tickValues(tickVals).tickSize(-5)).call(ax=>{ax.selectAll('text').remove();ax.select('.domain').remove();});
        gz.append('rect').attr('width',zpw).attr('height',zph).attr('fill','none').attr('stroke',paneColor).attr('stroke-width',1.5);

        // Interactive overlay: hover crosshair + click to add marker/annotation
        const zpOverlay=gz.append('rect').attr('width',zpw).attr('height',zph).attr('fill','transparent').style('cursor','crosshair');
        // Hover inspection
        zpOverlay.on('mousemove',ev=>{
            const[pmx]=d3.pointer(ev);
            gz.selectAll('.zp-hover').remove();
            gz.append('line').attr('class','zp-hover').attr('x1',pmx).attr('y1',0).attr('x2',pmx).attr('y2',zph)
                .attr('stroke','rgba(60,60,60,0.4)').attr('stroke-width',0.7).attr('stroke-dasharray','3,3').attr('pointer-events','none');
            const xVal=xz.invert(pmx);
            vis.forEach((ds,i)=>{
                const sm=smoothData(ds.data,smoothLevel);
                const nearest=sm.reduce((b,p)=>Math.abs(p.x-xVal)<Math.abs(b.x-xVal)?p:b,sm[0]);
                if(Math.abs(nearest.x-xVal)<span*0.1){
                    gz.append('circle').attr('class','zp-hover').attr('cx',xz(nearest.x)).attr('cy',yz(nearest.y+offsets[i])).attr('r',3.5)
                        .attr('fill',ds.color).attr('stroke','white').attr('stroke-width',1).attr('pointer-events','none');
                }
            });
        });
        zpOverlay.on('mouseleave',()=>gz.selectAll('.zp-hover').remove());
        // Click: shift = add marker, normal = annotate
        zpOverlay.on('click',ev=>{
            const[pmx]=d3.pointer(ev);const xVal=xz.invert(pmx);
            if(ev.shiftKey){
                zr.markers.push(xVal);drawEmbeddedZoomPanes();
            } else {
                const label=prompt(`Annotation at ${xVal.toFixed(2)}° (M${idx+1}):`,'');
                if(label!==null&&label.trim()){
                    if(!zr.annotations)zr.annotations=[];
                    zr.annotations.push({x:xVal,label:label.trim()});
                    drawEmbeddedZoomPanes();
                }
            }
        });

        // Markers footer
        if(zr.markers.length){
            const markersDiv=document.createElement('div');markersDiv.className='zoom-pane-markers';
            zr.markers.forEach((mk,mi)=>{
                const item=document.createElement('span');item.className='zpm-item';
                item.innerHTML=`${mk.toFixed(2)}° <button class="zpm-del">×</button>`;
                item.querySelector('.zpm-del').addEventListener('click',()=>{zr.markers.splice(mi,1);drawEmbeddedZoomPanes();});
                markersDiv.appendChild(item);
            });
            card.appendChild(markersDiv);
        }
        container.appendChild(card);
    });
}

/* ── LEFT NAVIGATION PREVIEW (temporary, auto-hide after 3s) ── */
function showNavPreview(){
    const el=document.getElementById('nav-preview');
    if(!datasets.length){el.style.display='none';return;}
    el.style.display='block';el.classList.remove('fade-out');
    const vis=datasets.filter(d=>d.visible);
    const w=160,h=50;
    const svg=d3.select('#nav-preview-svg').attr('width',w).attr('height',h);svg.selectAll('*').remove();
    svg.append('rect').attr('width',w).attr('height',h).attr('fill','#fafaf8').attr('rx',3);
    const allXMin=getGlobalXMin(),allXMax=getGlobalXMax();
    const mx=d3.scaleLinear().domain([allXMin,allXMax]).range([2,w-2]);
    const my=d3.scaleLinear().domain([0,1.1]).range([h-3,3]);
    vis.forEach(ds=>{
        const step=Math.max(1,Math.floor(ds.data.length/60));
        let pathD='M';
        for(let k=0;k<ds.data.length;k+=step) pathD+=`${mx(ds.data[k].x).toFixed(1)},${my(ds.data[k].y).toFixed(1)} `;
        svg.append('path').attr('d',pathD).attr('fill','none').attr('stroke',ds.color).attr('stroke-width',0.8).attr('opacity',0.5);
    });
    const curMin=interactiveXMin!==null?interactiveXMin:(_G.xMin||allXMin);
    const curMax=interactiveXMax!==null?interactiveXMax:(_G.xMax||allXMax);
    const rx1=Math.max(2,mx(curMin)),rx2=Math.min(w-2,mx(curMax));
    svg.append('rect').attr('x',rx1).attr('y',1).attr('width',Math.max(4,rx2-rx1)).attr('height',h-2)
        .attr('fill','rgba(42,92,170,0.2)').attr('stroke','rgba(42,92,170,0.7)').attr('stroke-width',1.5).attr('rx',2);
    // Show magnified regions on the preview too
    magnifyRanges.forEach((zr,idx)=>{
        const c=ZOOM_PANE_COLORS[idx%ZOOM_PANE_COLORS.length];
        const zx1=Math.max(2,mx(zr.from)),zx2=Math.min(w-2,mx(zr.to));
        svg.append('rect').attr('x',zx1).attr('y',1).attr('width',Math.max(2,zx2-zx1)).attr('height',h-2)
            .attr('fill',c).attr('fill-opacity',0.2).attr('stroke',c).attr('stroke-opacity',0.6).attr('stroke-width',1).attr('rx',1);
    });
    if(pinchPreviewTimer)clearTimeout(pinchPreviewTimer);
    pinchPreviewTimer=setTimeout(()=>{el.classList.add('fade-out');setTimeout(()=>{el.style.display='none';el.classList.remove('fade-out');},400);},3000);
}

/* ── CSV EXPORT (Y_norm = Y/Y_max * 100) ── */
function exportCSV(){
    const vis=datasets.filter(d=>d.visible);if(!vis.length)return;
    const wb=XLSX.utils.book_new();

    /* ── Sheet 1: "Main" — all datasets, normalized Y, common X grid ── */
    const allX=new Set();vis.forEach(ds=>ds.data.forEach(p=>allX.add(p.x)));
    const sortedX=[...allX].sort((a,b)=>a-b);
    const maps=vis.map(ds=>{const m=new Map();ds.data.forEach(p=>m.set(p.x,p.y));return m;});
    const maxYs=vis.map(ds=>d3.max(ds.data,d=>d.y)||1);
    const mainHeader=['2Theta',...vis.map(ds=>ds.label)];
    const mainRows=sortedX.map(x=>{
        const row=[+x.toFixed(4)];
        maps.forEach((m,i)=>{const y=m.get(x);row.push(y!==undefined?+(y/maxYs[i]*100).toFixed(4):'');});
        return row;
    });
    const mainSheet=XLSX.utils.aoa_to_sheet([mainHeader,...mainRows]);
    XLSX.utils.book_append_sheet(wb,mainSheet,'Main');

    /* ── Sheets M1, M2, ... — magnified region data ── */
    magnifyRanges.forEach((zr,idx)=>{
        const mHeader=['2Theta',...vis.map(ds=>ds.label)];
        const mMaps=vis.map(ds=>{const m=new Map();ds.data.forEach(p=>m.set(p.x,p.y));return m;});
        const regionX=sortedX.filter(x=>x>=zr.from&&x<=zr.to);
        const mRows=regionX.map(x=>{
            const row=[+x.toFixed(4)];
            mMaps.forEach((m,i)=>{const y=m.get(x);row.push(y!==undefined?+(y/maxYs[i]*100).toFixed(4):'');});
            return row;
        });
        const mSheet=XLSX.utils.aoa_to_sheet([mHeader,...mRows]);
        XLSX.utils.book_append_sheet(wb,mSheet,`M${idx+1}`);
    });

    /* ── Last sheet: "Datasets" — each dataset in its own X/Y columns ── */
    const maxLen=Math.max(...vis.map(ds=>ds.data.length));
    const dsHeader=[];vis.forEach(ds=>{dsHeader.push(`${ds.label} 2Theta`,`${ds.label} Intensity`);});
    const dsRows=[];
    for(let r=0;r<maxLen;r++){
        const row=[];
        vis.forEach(ds=>{
            if(r<ds.data.length){row.push(+ds.data[r].x.toFixed(4),+ds.data[r].y.toFixed(4));}
            else {row.push('','');}
        });
        dsRows.push(row);
    }
    const dsSheet=XLSX.utils.aoa_to_sheet([dsHeader,...dsRows]);
    XLSX.utils.book_append_sheet(wb,dsSheet,'Datasets');

    /* ── Download ── */
    XLSX.writeFile(wb,'xrd_data.xlsx');
}

/* ── EXPORT ── */
function getFullExportSVG(){
    const mainSvg=document.getElementById('main-svg');const mainClone=mainSvg.cloneNode(true);
    mainClone.querySelectorAll('.ch-v,.ch-dot,.drag-magnify-box').forEach(el=>el.remove());
    return new XMLSerializer().serializeToString(mainClone);
}


function handleFiles(files){
    const newDs=[];
    const readPromises=Array.from(files).map(f=>f.text().then(text=>{
        // Try multi-dataset CSV first
        if(f.name.toLowerCase().endsWith('.csv')){
            const multi=parseMultiCSV(text);
            if(multi){
                multi.forEach(md=>{
                    newDs.push({id:Date.now()+Math.random(),name:md.name,data:normalise(md.data),color:PALETTE[(datasets.length+newDs.length)%PALETTE.length],visible:true,label:md.name});
                });
                return;
            }
        }
        // Fallback: single XY file
        const pts=parseXY(text);
        if(pts.length>1) newDs.push({id:Date.now()+Math.random(),name:f.name.replace(/\.[^.]+$/,''),data:normalise(pts),color:PALETTE[(datasets.length+newDs.length)%PALETTE.length],visible:true,label:f.name.replace(/\.[^.]+$/,'')});
    }));
    Promise.all(readPromises).then(()=>{
        if(newDs.length){
            datasets.push(...newDs);
            // Auto-set main range to global data extent
            mainRange={from:getGlobalXMin(),to:getGlobalXMax()};
            document.getElementById('main-from').value=mainRange.from.toFixed(1);
            document.getElementById('main-to').value=mainRange.to.toFixed(1);
            interactiveXMin=null;interactiveXMax=null;
            document.getElementById('demo-notice').style.display='none';
            updateSidebar();scheduleRedraw();
        }
    });
}

/* ══════════════ EVENT LISTENERS ══════════════ */
document.addEventListener('DOMContentLoaded',()=>{
    buildColorGrid();
    document.getElementById('file-input').addEventListener('change',function(e){handleFiles(e.target.files);this.value='';});
    const dropZone=document.getElementById('drop-zone');
    ['dragenter','dragover'].forEach(ev=>dropZone.addEventListener(ev,e=>{e.preventDefault();e.stopPropagation();dropZone.style.borderColor='var(--accent)';}));
    ['dragleave','drop'].forEach(ev=>dropZone.addEventListener(ev,e=>{e.preventDefault();e.stopPropagation();dropZone.style.borderColor='';}));
    dropZone.addEventListener('drop',e=>{handleFiles(e.dataTransfer.files);});
    const plotContainer=document.getElementById('plot-container');
    ['dragenter','dragover'].forEach(ev=>plotContainer.addEventListener(ev,e=>{e.preventDefault();}));
    plotContainer.addEventListener('drop',e=>{e.preventDefault();handleFiles(e.dataTransfer.files);});

    ['stack-offset','line-width'].forEach(id=>{document.getElementById(id).addEventListener('input',function(){document.getElementById(id+'-val').textContent=(+this.value).toFixed(1);scheduleRedraw();});});

    // Simplified label toggles
    document.getElementById('label-stacked-btn').addEventListener('click',function(){
        labelMode='stacked';this.classList.add('active');document.getElementById('label-split-btn').classList.remove('active');scheduleRedraw();
    });
    document.getElementById('label-split-btn').addEventListener('click',function(){
        labelMode='split';this.classList.add('active');document.getElementById('label-stacked-btn').classList.remove('active');scheduleRedraw();
    });
    document.getElementById('label-side-btn').addEventListener('click',function(){
        labelSide=labelSide==='left'?'right':'left';this.textContent=labelSide==='left'?'Left':'Right';scheduleRedraw();
    });

    // Smoothing toggles
    document.querySelectorAll('.smooth-btn').forEach(btn=>{
        btn.addEventListener('click',function(){
            document.querySelectorAll('.smooth-btn').forEach(b=>b.classList.remove('active'));
            this.classList.add('active');smoothLevel=parseInt(this.dataset.smooth)||0;scheduleRedraw();
        });
    });

    // Tick toggles
    document.querySelectorAll('.tick-toggle').forEach(btn=>{btn.addEventListener('click',()=>{const side=btn.dataset.side;tickConfig[side]=!tickConfig[side];btn.classList.toggle('active',tickConfig[side]);scheduleRedraw();});});
    // Main range
    document.getElementById('apply-main-range').addEventListener('click',()=>{
        const f=parseFloat(document.getElementById('main-from').value),t=parseFloat(document.getElementById('main-to').value);
        if(isFinite(f)&&isFinite(t)&&t>f){mainRange={from:f,to:t};interactiveXMin=null;interactiveXMax=null;scheduleRedraw();showNavPreview();}
    });
    // Mouse button (deactivate all modes, restore normal cursor)
    document.getElementById('mouse-btn').addEventListener('click',function(){
        hoverMode=false;magnifySelectMode=false;annotMode=false;
        document.getElementById('hover-toggle').classList.remove('active');document.getElementById('hover-toggle').textContent='⊕ Hover Inspector';
        document.getElementById('xrd-tooltip').style.display='none';
        this.classList.add('active');
        updateModeButtons();scheduleRedraw();
    });
    // Toolbar buttons
    document.getElementById('redraw-btn').addEventListener('click',()=>{
        if(!datasets.length) return;
        interactiveXMin=getGlobalXMin();interactiveXMax=getGlobalXMax();
        scheduleRedraw();
    });
    document.getElementById('hover-toggle').addEventListener('click',function(){
        hoverMode=!hoverMode;if(hoverMode){magnifySelectMode=false;annotMode=false;}
        this.classList.toggle('active',hoverMode);this.textContent=hoverMode?'⊕ Inspector ON':'⊕ Hover Inspector';
        if(!hoverMode)document.getElementById('xrd-tooltip').style.display='none';updateModeButtons();scheduleRedraw();
    });
    document.getElementById('magnify-mode-btn').addEventListener('click',function(){
        magnifySelectMode=!magnifySelectMode;
        if(magnifySelectMode){hoverMode=false;annotMode=false;document.getElementById('hover-toggle').classList.remove('active');document.getElementById('hover-toggle').textContent='⊕ Hover Inspector';}
        updateModeButtons();scheduleRedraw();
    });
    document.getElementById('ann-mode-btn').addEventListener('click',function(){
        annotMode=!annotMode;
        if(annotMode){hoverMode=false;magnifySelectMode=false;document.getElementById('hover-toggle').classList.remove('active');document.getElementById('hover-toggle').textContent='⊕ Hover Inspector';}
        updateModeButtons();scheduleRedraw();
    });
    document.getElementById('peak-detect-btn').addEventListener('click',()=>{
        if(!datasets.length)return;
        datasets.filter(d=>d.visible).forEach(ds=>{
            const peaks=detectPeaks(smoothData(ds.data,smoothLevel),60,0.03);
            peaks.forEach(p=>{const exists=annotations.some(a=>Math.abs(a.x-p.x)<0.3&&a.dsId===ds.id);if(!exists)annotations.push({x:p.x,label:`${p.x.toFixed(1)}°`,type:'text',dsId:ds.id});});
        });
        renderAnnList();scheduleRedraw();
    });
    document.getElementById('load-demo').addEventListener('click',()=>{document.getElementById('demo-notice').style.display='none';loadDemo();});
    document.getElementById('clear-all').addEventListener('click',()=>{
        datasets=[];annotations=[];magnifyRanges=[];dropLines=[];
        mainRange={from:20,to:80};interactiveXMin=null;interactiveXMax=null;
        document.getElementById('main-from').value='20';document.getElementById('main-to').value='80';
        magnifySelectMode=false;annotMode=false;hoverMode=false;editingAnnIdx=-1;
        document.getElementById('ann-editor-section').style.display='none';
        document.getElementById('zoom-panes-container').innerHTML='';
        updateModeButtons();updateSidebar();renderMagnifyList();renderDropList();renderAnnList();scheduleRedraw();document.getElementById('demo-notice').style.display='block';
    });
    document.getElementById('clear-all-magnify').addEventListener('click',()=>{magnifyRanges=[];renderMagnifyList();drawEmbeddedZoomPanes();scheduleRedraw();});
    document.getElementById('add-drop').addEventListener('click',()=>{const dX=parseFloat(document.getElementById('drop-x').value);if(!isNaN(dX)){dropLines.push(dX);renderDropList();scheduleRedraw();}});
    document.getElementById('clear-drop').addEventListener('click',()=>{dropLines=[];renderDropList();scheduleRedraw();});
    document.getElementById('clear-ann').addEventListener('click',()=>{annotations=[];editingAnnIdx=-1;document.getElementById('ann-editor-section').style.display='none';renderAnnList();scheduleRedraw();});
    // Stack order toggle
    document.getElementById('stack-order-btn').addEventListener('click',function(){
        stackAscending=!stackAscending;
        this.textContent=stackAscending?'↑ Ascending':'↓ Descending';
        datasets.reverse();updateSidebar();scheduleRedraw();
    });
    // Aspect ratio toggles
    document.querySelectorAll('.aspect-btn').forEach(btn=>{
        btn.addEventListener('click',function(){
            document.querySelectorAll('.aspect-btn').forEach(b=>b.classList.remove('active'));
            this.classList.add('active');plotAspectRatio=this.dataset.ratio;scheduleRedraw();
        });
    });
    // Export
    document.getElementById('export-svg').addEventListener('click',()=>{const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([getFullExportSVG()],{type:'image/svg+xml'}));a.download='xrd_plot.svg';a.click();});
    document.getElementById('export-png').addEventListener('click',()=>{
        const svgStr=getFullExportSVG();const svgEl2=new DOMParser().parseFromString(svgStr,'image/svg+xml').documentElement;
        const W=+svgEl2.getAttribute('width')||800,H2=+svgEl2.getAttribute('height')||600;const sc=3;
        const cv=document.createElement('canvas');cv.width=W*sc;cv.height=H2*sc;const ctx=cv.getContext('2d');ctx.scale(sc,sc);
        const url=URL.createObjectURL(new Blob([svgStr],{type:'image/svg+xml;charset=utf-8'}));const img=new Image();
        img.onload=()=>{ctx.fillStyle='#fff';ctx.fillRect(0,0,W,H2);ctx.drawImage(img,0,0,W,H2);URL.revokeObjectURL(url);const a=document.createElement('a');a.href=cv.toDataURL('image/png');a.download='xrd_plot.png';a.click();};
        img.src=url;
    });
    document.getElementById('export-csv').addEventListener('click',exportCSV);
    // PPT hex input
    document.getElementById('ppt-apply-hex').addEventListener('click',()=>{const v=document.getElementById('ppt-hex-input').value;if(/^#[0-9a-fA-F]{6}$/.test(v))applyColor(v);});
    // Close popups
    document.addEventListener('click',e=>{
        const cp=document.getElementById('color-picker');if(cp.style.display!=='none'&&!cp.contains(e.target)&&!e.target.classList.contains('ds-swatch'))cp.style.display='none';
        const pop=document.getElementById('annotation-popover');if(pop.style.display!=='none'&&!pop.contains(e.target))pop.style.display='none';
    });
    document.getElementById('custom-color').addEventListener('input',e=>applyColor(e.target.value));

    /* ── PINCH-TO-ZOOM & TWO-FINGER SCROLL (boundary-clamped, with preview) ── */
    const svgEl=document.getElementById('main-svg');
    svgEl.addEventListener('wheel',ev=>{
        if(!_G.xScale||datasets.length===0) return;
        ev.preventDefault();
        const curMin=interactiveXMin!==null?interactiveXMin:_G.xMin;
        const curMax=interactiveXMax!==null?interactiveXMax:_G.xMax;
        const span=curMax-curMin;
        const rect=svgEl.getBoundingClientRect();
        const mx=ev.clientX-rect.left-_G.ml;
        const frac=Math.max(0,Math.min(1,mx/_G.pw));
        const cursorX=curMin+frac*span;
        let newMin,newMax;
        if(ev.ctrlKey||ev.metaKey){
            const gSpan=getGlobalXMax()-getGlobalXMin();
            const zoomFactor=ev.deltaY>0?1.15:0.87;
            const newSpan=Math.max(0.5,Math.min(gSpan,span*zoomFactor));
            newMin=cursorX-frac*newSpan;
            newMax=cursorX+(1-frac)*newSpan;
        } else {
            const panAmount=span*ev.deltaX*0.002;
            newMin=curMin+panAmount;
            newMax=curMax+panAmount;
        }
        const clamped=clampView(newMin,newMax);
        interactiveXMin=clamped.xMin;
        interactiveXMax=clamped.xMax;
        scheduleRedraw();
        // Show pinch preview (only for trackpad, not for tool modes)
        showNavPreview();
    },{passive:false});

    let resizeTimer=null;
    new ResizeObserver(()=>{if(resizeTimer)clearTimeout(resizeTimer);resizeTimer=setTimeout(()=>scheduleRedraw(true),100);}).observe(document.getElementById('plot-container'));
    updateSidebar();renderMagnifyList();renderDropList();renderAnnList();scheduleRedraw();
});
