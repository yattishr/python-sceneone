# 🎬 SceneOne Studio: UI/UX Design Specification

## 1. Design Philosophy: "The Obsidian Control Room"
SceneOne is defined as a **Generative Broadcast Suite**. The aesthetic is high-fidelity, professional, and reactive. It bridges the gap between a raw production environment and a futuristic AI interface.

* **Primary Palette:** `Obsidian` (#050505), `Slate-950` (#020617).
* **Accent Colors:**
    * `Action Red` (#EF4444) - Recording/Live status.
    * `Cyber Lime` (#ADFF2F) - Hype-Link Persona.
    * `Blueprint Blue` (#3B82F6) - Spec-Ops Persona.
    * `Amber Glow` (#F59E0B) - Maker’s Soul Persona.
* **Materials:** 15% opacity background blurs (Glassmorphism), 1px "Circuit" borders, and deep inner shadows.

---

## 2. Layout Architecture (12-Column Grid)
The Studio is divided into a **3-Zone Dashboard** to ensure focus and clarity.

### **Zone A: The Viewport (7 Columns)**
The hero element where the product "lives."
* **Element:** 16:9 Video Canvas with `2xl` rounded corners.
* **The HUD (Heads-Up Display):**
    * **Top-Left:** Pulsing `REC` indicator + `00:00:00` Timer.
    * **Top-Right:** Persona Badge (e.g., "MODE: HYPE-LINK").
    * **Bottom-Overlay:** Real-time Vision Logs (e.g., `[SYSTEM]: VOLKANO BT SPEAKER DETECTED`).
* **Visual Feedback:** A horizontal "Scanning Line" that pulses when the agent is identifying an object.

### **Zone B: The Director’s Console (5 Columns)**
The logic hub powered by CopilotKit and AG-UI.
* **Element:** `CopilotChat` embedded in a translucent, side-mounted panel.
* **Custom Labels:**
    * Title: "Director's Monitor"
    * Placeholder: "Wait, do you like the lighting?"
* **Thread UI:** Messages from the Director feature glowing left-borders that change color based on the active Persona.

### **Zone C: The Asset Dock (Full Width / Bottom)**
The "Output" tray for production results.
* **Element:** A horizontal scrolling list of "Asset Cards."
* **Card Contents:** * Product Name & Timestamp.
    * `Download .WAV` Primary Button.
    * `Copy Script` Secondary Button.

---

## 3. Component Architecture (React + Tailwind)

### **A. The Pulse Indicator**
```tsx
const RecordIndicator = () => (
  <div className="flex items-center gap-2 px-3 py-1 bg-black/60 backdrop-blur-md rounded-full border border-red-500/40">
    <div className="w-2 h-2 bg-red-600 rounded-full animate-pulse" />
    <span className="text-[10px] font-mono text-red-500 uppercase tracking-widest">Live Production</span>
  </div>
);