export const panelStyles = `
.scu-account{--scu-gap:16px;--scu-small:8px;--scu-radius:8px;--scu-font:16px;--scu-title:24px;--scu-width:512px;display:flex;flex-direction:column;gap:var(--scu-gap);max-width:var(--scu-width);width:100%;min-width:0;color:inherit;font-size:var(--scu-font)}
.scu-account h2,.scu-account p{margin:0}.scu-account h2{font-size:var(--scu-title)}
.scu-account form,.scu-account label{display:flex;flex-direction:column;gap:var(--scu-small)}
.scu-account form{gap:var(--scu-gap)}.scu-account input,.scu-account select,.scu-account button{font:inherit;color:inherit;background:transparent;border:1px solid currentColor;border-radius:var(--scu-radius);padding:var(--scu-small);min-width:0;max-width:100%;box-sizing:border-box}
.scu-account .scu-row{display:flex;flex-wrap:wrap;align-items:center;gap:var(--scu-small)}.scu-account .scu-check{flex-direction:row;align-items:center}.scu-account .scu-muted{opacity:.7}.scu-account button{cursor:pointer}.scu-account button:disabled{opacity:.5;cursor:wait}.scu-account img{max-width:100%;align-self:flex-start}.scu-account [role=alert]{overflow-wrap:anywhere}
`;
