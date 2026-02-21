/*  shadow-patch.js  –  Force ALL Shadow DOMs to be open
 *
 *  This runs at document_start in the MAIN world (page context),
 *  BEFORE the page's JavaScript creates any shadow roots.
 *  By overriding attachShadow, every shadow root created afterwards
 *  will be mode:"open", making it accessible to content scripts.
 */

(function () {
    const _original = Element.prototype.attachShadow;
    Element.prototype.attachShadow = function (init) {
        return _original.call(this, Object.assign({}, init, { mode: "open" }));
    };
})();
