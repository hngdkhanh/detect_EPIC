/* SearchSelect — dropdown có ô tìm kiếm: gõ để lọc (không dấu vẫn khớp),
   ↑/↓ di chuyển, Enter chọn, Esc/click ngoài để đóng */
import { useEffect, useRef, useState } from "react";

const vnorm = s => String(s).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/g, "d");

export default function SearchSelect({ options, value, onChange, width = 230, placeholder = "Gõ để tìm…" }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [hi, setHi] = useState(0);
  const boxRef = useRef(null);
  const inputRef = useRef(null);

  const current = options.find(o => o.value === value);
  const filtered = q ? options.filter(o => vnorm(o.label).includes(vnorm(q))) : options;

  useEffect(() => {
    const onDoc = e => { if (boxRef.current && !boxRef.current.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);
  useEffect(() => {
    if (open) { setQ(""); setHi(0); setTimeout(() => inputRef.current && inputRef.current.focus(), 0); }
  }, [open]);
  useEffect(() => { setHi(0); }, [q]);

  function pick(v) { onChange(v); setOpen(false); }
  function onKey(e) {
    if (e.key === "Escape") setOpen(false);
    else if (e.key === "ArrowDown") { e.preventDefault(); setHi(h => Math.min(h + 1, filtered.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setHi(h => Math.max(h - 1, 0)); }
    else if (e.key === "Enter") { e.preventDefault(); if (filtered[hi]) pick(filtered[hi].value); }
  }

  return (
    <div className="sselect" ref={boxRef} style={{ width }}>
      <button type="button" className="ss-btn" onClick={() => setOpen(o => !o)} title={current ? current.label : ""}>
        <span className="ss-label">{current ? current.label : "—"}</span>
        <span className="ss-caret">▾</span>
      </button>
      {open && (
        <div className="ss-pop">
          <input ref={inputRef} className="ss-search" placeholder={placeholder} value={q}
                 onChange={e => setQ(e.target.value)} onKeyDown={onKey} />
          <div className="ss-list">
            {filtered.map((o, i) => (
              <div key={o.value}
                   className={"ss-item" + (o.value === value ? " sel" : "") + (i === hi ? " hi" : "")}
                   onMouseEnter={() => setHi(i)}
                   onClick={() => pick(o.value)}>
                {o.label}
              </div>
            ))}
            {!filtered.length && <div className="ss-empty">Không tìm thấy</div>}
          </div>
        </div>
      )}
    </div>
  );
}
