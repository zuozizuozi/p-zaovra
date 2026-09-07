// Decorative fields remain separate from the readable product diagrams.
const media = matchMedia('(prefers-reduced-motion: reduce)')
const surfaces = [document.querySelector('.local-flow'), document.querySelector('.continuity'), document.querySelector('.approach-visual')]
const cleanups = surfaces.map((surface, index) => {
  const canvas = document.createElement('canvas')
  canvas.className = 'atmosphere'
  canvas.setAttribute('aria-hidden', 'true')
  surface.prepend(canvas)
  const ctx = canvas.getContext('2d')
  const pointer = {x:-1000,y:-1000}
  const attraction = {x:0,y:0,strength:0}
  let ripples = []
  let elapsed = 0
  let nextRipple = 0
  let lastTime = 0
  let width = 0
  let height = 0
  let frame = 0
  let visible = false
  const resize = new ResizeObserver(() => {
    width = surface.clientWidth
    height = surface.clientHeight
    const dpr = Math.min(devicePixelRatio, 1.5)
    canvas.width = width * dpr
    canvas.height = height * dpr
    ctx.setTransform(dpr,0,0,dpr,0,0)
    if (media.matches) draw(0)
  })
  function draw(time) {
    ctx.clearRect(0,0,width,height)
    const tick = media.matches ? 0 : time / 1000
    const delta = Math.min((time-lastTime)/1000, .05)
    lastTime = time
    if (!media.matches) elapsed += delta
    if(index === 1) {
      const radius = Math.min(width*.47,500)
      const cx = width*.15
      const cy = height*.45
      ctx.strokeStyle = 'rgba(129,166,210,.14)'
      ctx.lineWidth = 1
      for(let row=-4;row<=4;row++) {
        const y = row / 5 * radius
        const rx = Math.sqrt(radius*radius-y*y)
        ctx.beginPath();ctx.ellipse(cx,cy+y,rx,rx*.14,0,0,Math.PI*2);ctx.stroke()
      }
      for(let column=0;column<8;column++) {
        const angle = column*Math.PI/8 + tick*.025 + (pointer.x>0 ? (pointer.x/width-.5)*.12 : 0)
        ctx.beginPath();ctx.ellipse(cx,cy,Math.max(1,Math.abs(Math.cos(angle))*radius),radius,0,0,Math.PI*2);ctx.stroke()
      }
      const glow=ctx.createRadialGradient(cx,cy,0,cx,cy,radius)
      glow.addColorStop(0,'rgba(35,85,143,.03)');glow.addColorStop(.94,'rgba(85,139,201,.05)');glow.addColorStop(1,'rgba(85,139,201,0)')
      ctx.fillStyle=glow;ctx.beginPath();ctx.arc(cx,cy,radius,0,Math.PI*2);ctx.fill()
    } else {
      // Incommensurate waves create continuous wandering without random jumps.
      const autonomous = index === 0
      const targetX = autonomous ? width*(.5+.28*Math.sin(elapsed*.13)+.12*Math.sin(elapsed*.071+2)) : pointer.x
      const targetY = autonomous ? height*(.4+.22*Math.cos(elapsed*.11)+.1*Math.sin(elapsed*.173)) : pointer.y
      const engaged = autonomous || pointer.x >= 0
      const ease = 1-Math.exp(-delta*4)
      if(engaged) {
        attraction.x += (targetX-attraction.x)*ease
        attraction.y += (targetY-attraction.y)*ease
      }
      attraction.strength += ((engaged ? 1 : 0)-attraction.strength)*ease
      const radius = autonomous ? Math.min(width*.35,340) : 165
      const pull = media.matches ? 0 : attraction.strength
      const depth = autonomous ? 78 : 48
      // Each wave keeps its emission origin, even when the pointer moves away.
      if (engaged && pull > .5 && elapsed >= nextRipple && !media.matches) {
        ripples.push({x:attraction.x, y:attraction.y-depth*pull, born:elapsed})
        nextRipple = elapsed + 1.9
      }
      ripples = media.matches ? [] : ripples.filter(wave => elapsed-wave.born < 5.8)
      const waves = ripples.map(wave => ({...wave, radius:(elapsed-wave.born)*radius*.43, fade:Math.sin(Math.min(1,(elapsed-wave.born)/.55)*Math.PI/2)*Math.pow(1-(elapsed-wave.born)/5.8,2)}))
      // An oblique plane: both grid axes share the same well and wave displacement.
      function deform(x,y) {
        const dx = attraction.x-x
        const dy = (attraction.y-depth*pull-y)/.62
        const well = Math.exp(-(dx*dx+dy*dy)/(radius*radius*.62))*pull
        const waveHeight = waves.reduce((sum,wave) => {
          const distance = Math.hypot(x-wave.x,(y-wave.y)/.62)
          const offset = (distance-wave.radius)/18
          return sum + Math.exp(-offset*offset)*Math.cos(offset*1.2)*9*wave.fade
        },0)
        return {x:x+dx*well*.16, y:y+depth*well-waveHeight}
      }
      const columns = autonomous ? 42 : 24
      const rows = autonomous ? 34 : 24
      function plane(u,v) {
        return deform(width*.5+(u-.5)*width*1.7*(.7+v*.6),-height*.15+v*height*1.3)
      }
      ctx.lineWidth=.7
      for(let axis=0;axis<2;axis++) {
        const count=axis===0?rows:columns
        for(let line=0;line<=count;line++) {
          ctx.beginPath()
          for(let sample=0;sample<=80;sample++) {
            const point=plane(axis===0?sample/80:line/count,axis===0?line/count:sample/80)
            if(sample===0)ctx.moveTo(point.x,point.y)
            else ctx.lineTo(point.x,point.y)
          }
          ctx.strokeStyle=`rgba(111,168,235,${line%4===0?.19:.095})`
          ctx.stroke()
        }
      }
      // Restrained intersection lights make the mesh readable without a starfield.
      ctx.fillStyle='rgba(151,209,255,.3)'
      for(let row=1;row<rows;row+=2) {
        for(let column=1;column<columns;column+=2) {
          const point=plane(column/columns,row/rows)
          ctx.fillRect(point.x-.65,point.y-.65,1.3,1.3)
        }
      }
      waves.forEach(wave => {
        ctx.beginPath()
        for(let sample=0;sample<=120;sample++) {
          const angle=sample/120*Math.PI*2
          const point=deform(wave.x+Math.cos(angle)*wave.radius,wave.y+Math.sin(angle)*wave.radius*.62)
          if(sample===0)ctx.moveTo(point.x,point.y)
          else ctx.lineTo(point.x,point.y)
        }
        ctx.closePath()
        ctx.strokeStyle=`rgba(113,188,255,${wave.fade*.09})`
        ctx.lineWidth=6
        ctx.stroke()
        ctx.strokeStyle=`rgba(153,211,255,${wave.fade*.5})`
        ctx.lineWidth=.85
        ctx.stroke()
      })
      const glow=ctx.createRadialGradient(attraction.x,attraction.y,0,attraction.x,attraction.y,radius*.62)
      glow.addColorStop(0,`rgba(100,180,255,${pull*.16})`)
      glow.addColorStop(.25,`rgba(48,117,238,${pull*.075})`)
      glow.addColorStop(1,'rgba(48,117,238,0)')
      ctx.fillStyle=glow
      ctx.fillRect(0,0,width,height)
    }
    if(visible && !media.matches) frame=requestAnimationFrame(draw)
  }
  const observer = new IntersectionObserver(entries => {
    visible=entries[0].isIntersecting
    cancelAnimationFrame(frame)
    if(visible) draw(performance.now())
  })
  const onMove = event => { if(event.pointerType==='touch') return;const rect=surface.getBoundingClientRect();pointer.x=event.clientX-rect.left;pointer.y=event.clientY-rect.top }
  const onLeave = () => {pointer.x=-1000;pointer.y=-1000}
  const onMedia = () => {cancelAnimationFrame(frame);if(visible)draw(performance.now())}
  if(index !== 0) {
    surface.addEventListener('pointermove',onMove)
    surface.addEventListener('pointerleave',onLeave)
  }
  media.addEventListener('change',onMedia)
  resize.observe(surface);observer.observe(surface)
  return () => {cancelAnimationFrame(frame);resize.disconnect();observer.disconnect();surface.removeEventListener('pointermove',onMove);surface.removeEventListener('pointerleave',onLeave);media.removeEventListener('change',onMedia)}
})
window.addEventListener('pagehide',()=>cleanups.forEach(cleanup=>cleanup()),{once:true})
