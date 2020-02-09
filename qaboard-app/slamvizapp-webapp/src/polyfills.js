// At the moment, we support Internet Explorer 11+. It needs a little help.
// When everybody moves to modern browers, remove all of this!
//
// Known dependencies that require polyfills
// - https://reactjs.org/docs/javascript-environment-requirements.html
// - https://blueprintjs.com/docs/#blueprint/getting-started.js-environment
// 
// Possible polyfill providers
// - https://www.npmjs.com/package/core-js
// - es6-shim
// - babel-polyfill
//
// Note: ie11 on win7 has fetch but not 308 redirects
//       it can cause issues if you call POST API endpoints without a trailing slash

import "dom4";
import 'intersection-observer';

// We follow the recommendations from
// https://developer.mozilla.org/en-US/docs/Web/API/ChildNode/remove
// Alternatively, if more DOM polyfills are to be added, consider
//    > npm install --save dom4
//    ~
//    ~ require("dom4")
//    ~
//
// from:https://github.com/jserz/js_piece/blob/master/DOM/ChildNode/remove()/remove().md
// eslint-disable-next-line
(function (arr) {
  arr.forEach(function (item) {
    if (item.hasOwnProperty('remove')) {
      return;
    }
    Object.defineProperty(item, 'remove', {
      configurable: true,
      enumerable: true,
      writable: true,
      value: function remove() {
        if (this.parentNode === null) {
          return;
        }
        this.parentNode.removeChild(this);
      }
    });
  });
})([Element.prototype, CharacterData.prototype, DocumentType.prototype]);



// https://developer.mozilla.org/en-US/docs/Web/API/Element/closest
if (!Element.prototype.matches)
    Element.prototype.matches = Element.prototype.msMatchesSelector || 
                                Element.prototype.webkitMatchesSelector;
if (!Element.prototype.closest)
    Element.prototype.closest = function(s) {
        var el = this;
        if (!document.documentElement.contains(el)) return null;
        do {
            if (el.matches(s)) return el;
            el = el.parentElement || el.parentNode;
          // eslint-disable-next-line
        } while (el !== null && el.nodeType == 1); 
        return null;
    };
