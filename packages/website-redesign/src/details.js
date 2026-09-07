import { gsap } from "gsap"
import { ScrollTrigger } from "gsap/ScrollTrigger"
import "./details.css"

const emblem = '<span class="brand-emblem"><img src="/assets/zaovra-logo-dark-square.png" alt="" /></span>'
document.querySelector('.brand').innerHTML = `${emblem}<span class="brand-name">zaovra<span>CODING WORKSPACE</span></span>`
document.querySelector('.footer-brand > img').outerHTML = `<a class="brand footer-lockup" href="#top" aria-label="Zaovra home">${emblem}<span class="brand-name">zaovra<span>CODING WORKSPACE</span></span></a>`
document.querySelector('.context-orbit').innerHTML = `<svg class="context-links" viewBox="0 0 320 280" aria-hidden="true"><path d="M160 140V42M160 140H48M160 140H272M160 140V238"/></svg><div class="context-center">${emblem}<strong>Zaovra</strong></div><span class="context-label context-north">Project rules</span><span class="context-label context-west">Files</span><span class="context-label context-east">Tools</span><span class="context-label context-south">Session history</span>`
document.querySelector('.final-copy > img').outerHTML = `<div class="final-emblem">${emblem}</div>`
document.querySelectorAll('a[href^="https://github.com/zaovra"]').forEach(link => { link.href = link.href.replace('github.com/zaovra', 'github.com/zuozizuozi/p-zaovra') })
document.querySelector('.desktop-nav a[href="#faq"]').href = 'https://zaovra.com/docs'

const radar = document.querySelector('.radar')
radar.insertAdjacentHTML('afterbegin', '<span class="instrument-title">BUG RADAR <i>SIMULATED SCAN</i></span>')
const radarRings = document.querySelector('.radar-rings')
radarRings.insertAdjacentHTML('beforeend', '<div class="radar-sweep"></div><div class="radar-reticle"></div><span class="radar-origin"></span>')
document.querySelector('.radar-core').remove()
document.querySelector('.radar-axis').remove()
document.querySelector('.radar-readout').innerHTML = 'Scanning for signals<br />Illustrative bug detection'

document.querySelector('.flow-node-top').remove()
document.querySelector('.flow-cut').remove()
document.querySelector('.flow-down').remove()
document.querySelector('.flow-node-bottom').remove()
document.querySelector('.active-node').insertAdjacentHTML('afterbegin', emblem)
const flowDescriptions = ['Read project files, Git state, and repository instructions.', 'Connect context, model responses, and tools in one controlled loop.', 'Inspect the changes and test results before you choose what to ship.']
document.querySelectorAll('.flow-row .flow-node')[2].innerHTML = 'REVIEWABLE OUTPUT<span>diffs · tests · your approval</span>'
document.querySelector('.flow-diagram').insertAdjacentHTML('afterbegin', '<span class="flow-caption">FROM REPOSITORY TO REVIEW</span>')
document.querySelector('.flow-diagram').insertAdjacentHTML('beforeend', '<p class="flow-inspector"><span>EXPLORE THE SYSTEM</span><b>Hover or focus a node to inspect its role.</b></p>')
document.querySelectorAll('.flow-row .flow-node').forEach((node,i) => {
  node.tabIndex = 0
  node.addEventListener('pointerenter', () => { document.querySelector('.flow-inspector b').textContent = flowDescriptions[i] })
  node.addEventListener('focus', () => { document.querySelector('.flow-inspector b').textContent = flowDescriptions[i] })
  node.addEventListener('click', () => { document.querySelector('.flow-inspector b').textContent = flowDescriptions[i] })
})

const sessionDescriptions = ['Project history loaded', 'Request saved to session', 'Tools run with permission', 'Changes ready for review']
const sessionPreviews = [
  ['Start with the full picture.', 'Zaovra reads the repository, project rules, and relevant session history before the next step begins.', 'Workspace context', '<div class="preview-files"><span>src/session.ts<b>Project files</b></span><span>AGENTS.md<b>Project rules</b></span><span>Session history<b>Previous decisions</b></span></div>'],
  ['Your request, kept in context.', 'Your input is saved to the session before execution is scheduled. The request remains part of the work, beyond a single model response.', 'Durable input', '<div class="preview-request">Refactor the session handler.<br />Keep the public API unchanged.</div><div class="preview-receipt"><span>Saved to session</span><span>Awaiting execution</span></div>'],
  ['Tools run. You stay in control.', 'Agents inspect files, run commands, and make changes within the permissions you configure. Tool activity stays visible for review.', 'Tool activity', '<div class="preview-files"><span>Read project files<b>Allowed</b></span><span>Run a command<b>Permission checked</b></span><span>Edit the implementation<b>Changes tracked</b></span></div>'],
  ['Review the change, then decide.', 'See the diff and tool results before you choose what to ship. The final review and merge remain yours.', 'Change review', '<div class="preview-diff"><span>src/session.ts</span><code class="removed">− const state = await load()</code><code class="added">+ const state = await load(sessionID)</code></div><div class="preview-receipt"><span>Diff available</span><span>Ready for your review</span></div>'],
]
const sessionPreview = document.querySelector('.continuity-copy')
sessionPreview.id = 'session-preview'
sessionPreview.setAttribute('role', 'region')
sessionPreview.insertAdjacentHTML('beforeend', '<div class="session-interface"><div class="preview-heading"><strong></strong><span>Illustrative preview</span></div><div class="preview-content"></div></div>')
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)')
let previewFade
let selectedSession = -1
const showSession = i => {
  sessionPreview.setAttribute('aria-labelledby', `session-step-${i}`)
  sessionPreview.querySelector('h2').textContent = sessionPreviews[i][0]
  sessionPreview.querySelector('p').textContent = sessionPreviews[i][1]
  sessionPreview.querySelector('.preview-heading strong').textContent = sessionPreviews[i][2]
  sessionPreview.querySelector('.preview-content').innerHTML = sessionPreviews[i][3]
}
const settlePreview = () => { previewFade?.cancel(); if(selectedSession >= 0) showSession(selectedSession) }
reducedMotion.addEventListener('change', settlePreview)
window.addEventListener('pagehide', () => { previewFade?.cancel(); reducedMotion.removeEventListener('change', settlePreview) }, {once:true})
document.querySelectorAll('.checkpoint').forEach((node,i) => {
  node.insertAdjacentHTML('beforeend', `<small>${sessionDescriptions[i]}</small><i class="checkpoint-light"></i>`)
  node.tabIndex = 0
  const activate = () => {
    if(selectedSession === i) return
    const initial = selectedSession < 0
    selectedSession = i
    document.querySelectorAll('.checkpoint').forEach((item,j) => { item.classList.toggle('live', i === j); item.classList.toggle('complete', j < i); item.setAttribute('aria-pressed', String(i === j)) })
    document.querySelector('.session-status b').textContent = sessionDescriptions[i]
    const opacity = getComputedStyle(sessionPreview).opacity
    previewFade?.cancel()
    if(initial || reducedMotion.matches) { showSession(i); return }
    previewFade = sessionPreview.animate([{opacity}, {opacity:0}], {duration:180, easing:'cubic-bezier(.4,0,.6,1)', fill:'forwards'})
    previewFade.onfinish = () => {
      showSession(i)
      previewFade.cancel()
      previewFade = sessionPreview.animate([{opacity:0}, {opacity:1}], {duration:300, easing:'cubic-bezier(.22,1,.36,1)'})
    }
  }
  node.addEventListener('pointerenter', activate)
  node.addEventListener('focus', activate)
  node.addEventListener('click', activate)
})
document.querySelector('.session-map').insertAdjacentHTML('beforeend', '<div class="session-status"><span>SESSION PREVIEW</span><b>Request saved to session</b></div>')
document.querySelector('.checkpoint.live').click()

const glyphs = [
  '<path d="M8 8h12v12H8zM44 8h12v12H44zM26 44h12v12H26zM20 14h24M14 20v12h18v12M50 20v12H32"/>',
  '<circle cx="32" cy="32" r="8"/><circle cx="10" cy="12" r="5"/><circle cx="54" cy="12" r="5"/><circle cx="10" cy="52" r="5"/><circle cx="54" cy="52" r="5"/><path d="m14 16 12 11m12 0 12-11M14 48l12-11m12 0 12 11"/>',
  '<rect x="6" y="10" width="52" height="42" rx="3"/><path d="m17 24 8 7-8 7m16 0h14M6 18h52"/>',
  '<path d="M14 20a22 22 0 1 1-3 26M6 10v14h14M32 18v16l10 6"/>',
  '<path d="m18 16-13 16 13 16m28-32 13 16-13 16M38 10 26 54"/>',
  '<path d="M14 6h26l10 10v42H14zM40 6v12h10M23 30h18M23 40h18M32 23v14"/>'
]
document.querySelectorAll('.capability-grid article').forEach((card,i) => card.insertAdjacentHTML('afterbegin', `<svg class="capability-glyph" viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true">${glyphs[i]}</svg>`))

const detailsMotion = gsap.matchMedia()
detailsMotion.add('(prefers-reduced-motion: no-preference)', () => {
  const bugNames = ['Null reference', 'Type mismatch', 'Race condition', 'Memory leak', 'Unhandled error', 'Stale state', 'Missing await', 'Index overflow']
  let nextSignal = .6
  let signals = []
  const readout = document.querySelector('.radar-readout')
  let signalCount = -1
  const sweep = gsap.to('.radar-sweep', { rotation:360, duration:7, repeat:-1, ease:'none', paused:true, onUpdate() {
    const time = this.totalTime()
    signals = signals.filter(signal => {
      const age = time-signal.born
      if(age > 5.2) { signal.element.remove(); return false }
      signal.element.style.opacity = Math.max(0, Math.min(1, age/.25, (5.2-age)/1.2))
      return true
    })
    if(time >= nextSignal) {
      nextSignal = time+1.2+Math.random()*1.7
      const angle = this.progress()*Math.PI*2
      const radius = 22+Math.random()*16
      const x = 50+Math.sin(angle)*radius
      const y = 50-Math.cos(angle)*radius
      if(signals.length < 3 && !signals.some(signal => Math.abs(signal.y-y)<18)) {
        const element = document.createElement('span')
        element.className = `radar-contact${x>50?' label-left':''}`
        element.style.left = `${x}%`
        element.style.top = `${y}%`
        element.style.opacity = 0
        element.innerHTML = `<i></i><small>${bugNames[Math.floor(Math.random()*bugNames.length)]}</small>`
        radarRings.append(element)
        signals.push({element,y,born:time})
      }
    }
    if(signalCount !== signals.length) {
      signalCount = signals.length
      readout.innerHTML = `${signals.length ? `${signals.length} transient signal${signals.length>1?'s':''} detected` : 'Scanning for signals'}<br />Illustrative bug detection`
    }
  } })
  ScrollTrigger.create({ trigger:radar, start:'top bottom', end:'bottom top', onToggle:self => self.isActive ? sweep.play() : sweep.pause() })
  const listeners = new AbortController()
  if (matchMedia('(hover: hover) and (pointer: fine)').matches) {
    document.querySelectorAll('.problem-card, .capability-grid article, .approach-visual, .flow-node, .install-box').forEach(card => {
      card.classList.add('interactive-surface')
      const moveX = gsap.quickTo(card, '--light-x', {duration:.25})
      const moveY = gsap.quickTo(card, '--light-y', {duration:.25})
      card.addEventListener('pointermove', event => {
        const bounds = card.getBoundingClientRect()
        moveX(event.clientX - bounds.left)
        moveY(event.clientY - bounds.top)
      }, {signal:listeners.signal})
    })
  }
  document.querySelectorAll('.step').forEach(step => step.addEventListener('click', () => {
    gsap.fromTo('.panel-stage > :not([hidden])', {opacity:0, y:12}, {opacity:1,y:0,duration:.4,overwrite:true})
  }, {signal:listeners.signal}))
  return () => { listeners.abort(); signals.forEach(signal => signal.element.remove()); document.querySelector('.radar-readout').innerHTML = 'Scanning preview paused<br />Illustrative bug detection' }
})
window.addEventListener('pagehide', () => detailsMotion.revert(), {once:true})
import('./atmosphere.js')
