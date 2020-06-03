(window.webpackJsonp=window.webpackJsonp||[]).push([[32],{165:function(e,t,n){"use strict";n.r(t),n.d(t,"frontMatter",(function(){return o})),n.d(t,"metadata",(function(){return l})),n.d(t,"rightToc",(function(){return b})),n.d(t,"default",(function(){return p}));var a=n(1),i=n(9),r=(n(0),n(181)),c=n(183),o={id:"using-the-qa-cli",sidebar_label:"QA CLI Tips",title:"Tips for CLI usage"},l={id:"using-the-qa-cli",title:"Tips for CLI usage",description:"CLI flags worth knowing",source:"@site/docs/using-the-qa-cli.md",permalink:"/qaboard/docs/using-the-qa-cli",editUrl:"https://github.com/Samsung/qaboard/edit/master/website/docs/using-the-qa-cli.md",sidebar_label:"QA CLI Tips",sidebar:"docs",previous:{title:"Specifying configurations",permalink:"/qaboard/docs/specifying-configurations"},next:{title:"References & Milestones",permalink:"/qaboard/docs/references-and-milestones"}},b=[{value:"CLI flags worth knowing",id:"cli-flags-worth-knowing",children:[]},{value:"<code>qa --help</code>",id:"qa---help",children:[]},{value:"<code>qa --share</code>",id:"qa---share",children:[]},{value:"<code>qa --dryrun</code>",id:"qa---dryrun",children:[]},{value:"<code>qa --label my-label</code>",id:"qa---label-my-label",children:[]},{value:"<code>qa batch</code>",id:"qa-batch",children:[{value:"Batch Runners",id:"batch-runners",children:[]},{value:"Dealing with existing results",id:"dealing-with-existing-results",children:[]}]},{value:"Connecting to a custom QA-Board instance",id:"connecting-to-a-custom-qa-board-instance",children:[]}],s={rightToc:b};function p(e){var t=e.components,n=Object(i.a)(e,["components"]);return Object(r.b)("wrapper",Object(a.a)({},s,n,{components:t,mdxType:"MDXLayout"}),Object(r.b)("h2",{id:"cli-flags-worth-knowing"},"CLI flags worth knowing"),Object(r.b)("h2",{id:"qa---help"},Object(r.b)("inlineCode",{parentName:"h2"},"qa --help")),Object(r.b)("p",null,"All commands have some help:"),Object(r.b)("pre",null,Object(r.b)("code",Object(a.a)({parentName:"pre"},{className:"language-bash"}),"qa --help\nqa batch --help\n")),Object(r.b)("h2",{id:"qa---share"},Object(r.b)("inlineCode",{parentName:"h2"},"qa --share")),Object(r.b)("p",null,"When you run ",Object(r.b)("inlineCode",{parentName:"p"},"qa batch")," or ",Object(r.b)("inlineCode",{parentName:"p"},"qa run")," on your terminal, results are saved locally under ",Object(r.b)("strong",{parentName:"p"},"output/"),", and ",Object(r.b)("em",{parentName:"p"},"they are not visible in QA-Board"),". To make them visible:"),Object(r.b)("div",{className:"admonition admonition-tip alert alert--success"},Object(r.b)("div",Object(a.a)({parentName:"div"},{className:"admonition-heading"}),Object(r.b)("h5",{parentName:"div"},Object(r.b)("span",Object(a.a)({parentName:"h5"},{className:"admonition-icon"}),Object(r.b)("svg",Object(a.a)({parentName:"span"},{xmlns:"http://www.w3.org/2000/svg",width:"12",height:"16",viewBox:"0 0 12 16"}),Object(r.b)("path",Object(a.a)({parentName:"svg"},{fillRule:"evenodd",d:"M6.5 0C3.48 0 1 2.19 1 5c0 .92.55 2.25 1 3 1.34 2.25 1.78 2.78 2 4v1h5v-1c.22-1.22.66-1.75 2-4 .45-.75 1-2.08 1-3 0-2.81-2.48-5-5.5-5zm3.64 7.48c-.25.44-.47.8-.67 1.11-.86 1.41-1.25 2.06-1.45 3.23-.02.05-.02.11-.02.17H5c0-.06 0-.13-.02-.17-.2-1.17-.59-1.83-1.45-3.23-.2-.31-.42-.67-.67-1.11C2.44 6.78 2 5.65 2 5c0-2.2 2.02-4 4.5-4 1.22 0 2.36.42 3.22 1.19C10.55 2.94 11 3.94 11 5c0 .66-.44 1.78-.86 2.48zM4 14h5c-.23 1.14-1.3 2-2.5 2s-2.27-.86-2.5-2z"})))),"tip")),Object(r.b)("div",Object(a.a)({parentName:"div"},{className:"admonition-content"}),Object(r.b)("p",{parentName:"div"},"If you don't like this default, make ",Object(r.b)("inlineCode",{parentName:"p"},"--share")," the default via  "),Object(r.b)("pre",{parentName:"div"},Object(r.b)("code",Object(a.a)({parentName:"pre"},{className:"language-bash"}),'# .bashrc or other shell config\nalias qa="qa --share"\n\n# you can also use an environment variable\nexport QA_SHARE=true\n')))),Object(r.b)("h2",{id:"qa---dryrun"},Object(r.b)("inlineCode",{parentName:"h2"},"qa --dryrun")),Object(r.b)("p",null,Object(r.b)("inlineCode",{parentName:"p"},"qa")," commmands support a ",Object(r.b)("inlineCode",{parentName:"p"},"--dryrun")," mode, where they print actions they would take, but don't actually do anything. In particular it helps see quickly what inputs you defined in a batch:"),Object(r.b)("pre",null,Object(r.b)("code",Object(a.a)({parentName:"pre"},{className:"language-bash"}),"qa --dryrun batch my-batch\n# qa run --input image/A.jpg\n# qa run --input image/B.jpg\n")),Object(r.b)("div",{className:"admonition admonition-note alert alert--secondary"},Object(r.b)("div",Object(a.a)({parentName:"div"},{className:"admonition-heading"}),Object(r.b)("h5",{parentName:"div"},Object(r.b)("span",Object(a.a)({parentName:"h5"},{className:"admonition-icon"}),Object(r.b)("svg",Object(a.a)({parentName:"span"},{xmlns:"http://www.w3.org/2000/svg",width:"14",height:"16",viewBox:"0 0 14 16"}),Object(r.b)("path",Object(a.a)({parentName:"svg"},{fillRule:"evenodd",d:"M6.3 5.69a.942.942 0 0 1-.28-.7c0-.28.09-.52.28-.7.19-.18.42-.28.7-.28.28 0 .52.09.7.28.18.19.28.42.28.7 0 .28-.09.52-.28.7a1 1 0 0 1-.7.3c-.28 0-.52-.11-.7-.3zM8 7.99c-.02-.25-.11-.48-.31-.69-.2-.19-.42-.3-.69-.31H6c-.27.02-.48.13-.69.31-.2.2-.3.44-.31.69h1v3c.02.27.11.5.31.69.2.2.42.31.69.31h1c.27 0 .48-.11.69-.31.2-.19.3-.42.31-.69H8V7.98v.01zM7 2.3c-3.14 0-5.7 2.54-5.7 5.68 0 3.14 2.56 5.7 5.7 5.7s5.7-2.55 5.7-5.7c0-3.15-2.56-5.69-5.7-5.69v.01zM7 .98c3.86 0 7 3.14 7 7s-3.14 7-7 7-7-3.12-7-7 3.14-7 7-7z"})))),"note")),Object(r.b)("div",Object(a.a)({parentName:"div"},{className:"admonition-content"}),Object(r.b)("p",{parentName:"div"},"For ",Object(r.b)("inlineCode",{parentName:"p"},"qa --dryrun run"),", you are expected to handle ",Object(r.b)("inlineCode",{parentName:"p"},'if context.obj["dryrun"]: ...')," yourself in ",Object(r.b)("inlineCode",{parentName:"p"},"run()"),". The use-case is usually printing how you would call an executable, for debugging."))),Object(r.b)("h2",{id:"qa---label-my-label"},Object(r.b)("inlineCode",{parentName:"h2"},"qa --label my-label")),Object(r.b)("p",null,"Everytime you ",Object(r.b)("inlineCode",{parentName:"p"},"qa run"),", it erases previous results. So if you want compare different versions by tweaking doing ",Object(r.b)("inlineCode",{parentName:"p"},"qa run"),", it won't work. Fortunately, ",Object(r.b)("inlineCode",{parentName:"p"},"qa"),' lets you give a "label", or "experiment name" to runs. Results with different labels are stored separately:'),Object(r.b)("pre",null,Object(r.b)("code",Object(a.a)({parentName:"pre"},{}),"qa --label without-optimizations batch validation-images\nqa --label    with-optimizations batch validation-images\n")),Object(r.b)("img",{alt:"select-batch",src:Object(c.a)("img/select-batch.png")}),Object(r.b)("div",{className:"admonition admonition-tip alert alert--success"},Object(r.b)("div",Object(a.a)({parentName:"div"},{className:"admonition-heading"}),Object(r.b)("h5",{parentName:"div"},Object(r.b)("span",Object(a.a)({parentName:"h5"},{className:"admonition-icon"}),Object(r.b)("svg",Object(a.a)({parentName:"span"},{xmlns:"http://www.w3.org/2000/svg",width:"12",height:"16",viewBox:"0 0 12 16"}),Object(r.b)("path",Object(a.a)({parentName:"svg"},{fillRule:"evenodd",d:"M6.5 0C3.48 0 1 2.19 1 5c0 .92.55 2.25 1 3 1.34 2.25 1.78 2.78 2 4v1h5v-1c.22-1.22.66-1.75 2-4 .45-.75 1-2.08 1-3 0-2.81-2.48-5-5.5-5zm3.64 7.48c-.25.44-.47.8-.67 1.11-.86 1.41-1.25 2.06-1.45 3.23-.02.05-.02.11-.02.17H5c0-.06 0-.13-.02-.17-.2-1.17-.59-1.83-1.45-3.23-.2-.31-.42-.67-.67-1.11C2.44 6.78 2 5.65 2 5c0-2.2 2.02-4 4.5-4 1.22 0 2.36.42 3.22 1.19C10.55 2.94 11 3.94 11 5c0 .66-.44 1.78-.86 2.48zM4 14h5c-.23 1.14-1.3 2-2.5 2s-2.27-.86-2.5-2z"})))),"tip")),Object(r.b)("div",Object(a.a)({parentName:"div"},{className:"admonition-content"}),Object(r.b)("p",{parentName:"div"},"To keep previous output files, use ",Object(r.b)("inlineCode",{parentName:"p"},"qa batch/run --keep-previous")," or ",Object(r.b)("inlineCode",{parentName:"p"},"EXPORT QA_KEEP_PREVIOUS=true"),". It can be useful if you are debugging long runs and implemented a caching mecanism. ",Object(r.b)("em",{parentName:"p"},"(Experimental)")))),Object(r.b)("h2",{id:"qa-batch"},Object(r.b)("inlineCode",{parentName:"h2"},"qa batch")),Object(r.b)("h3",{id:"batch-runners"},"Batch Runners"),Object(r.b)("p",null,"While ",Object(r.b)("inlineCode",{parentName:"p"},"qa run")," uses the local environment, ",Object(r.b)("inlineCode",{parentName:"p"},"qa batch"),' will offload computation to a "runner" backend. Currently:'),Object(r.b)("ul",null,Object(r.b)("li",{parentName:"ul"},"On Windows we use ",Object(r.b)("a",Object(a.a)({parentName:"li"},{href:"http://joblib.readthedocs.io/"}),Object(r.b)("inlineCode",{parentName:"a"},"joblib"))," for parallel computing. You can set the concurrency with ",Object(r.b)("inlineCode",{parentName:"li"},"QATOOLS_BATCH_CONCURRENCY")," and ",Object(r.b)("a",Object(a.a)({parentName:"li"},{href:"https://joblib.readthedocs.io/en/latest/parallel.html"}),"other environment variables")," from ",Object(r.b)("inlineCode",{parentName:"li"},"joblib"),". ",Object(r.b)("inlineCode",{parentName:"li"},"runners.local.concurrency")," in ",Object(r.b)("em",{parentName:"li"},"qaboard.yaml")," also works..."),Object(r.b)("li",{parentName:"ul"},"On linux we use SIRC's LSF cluster")),Object(r.b)("p",null,"You can also set the runner via ",Object(r.b)("inlineCode",{parentName:"p"},"--runner=local"),", and even set a default with ",Object(r.b)("inlineCode",{parentName:"p"},"runners.default: local")," in ",Object(r.b)("em",{parentName:"p"},"qaboard.yaml"),"."),Object(r.b)("div",{className:"admonition admonition-note alert alert--secondary"},Object(r.b)("div",Object(a.a)({parentName:"div"},{className:"admonition-heading"}),Object(r.b)("h5",{parentName:"div"},Object(r.b)("span",Object(a.a)({parentName:"h5"},{className:"admonition-icon"}),Object(r.b)("svg",Object(a.a)({parentName:"span"},{xmlns:"http://www.w3.org/2000/svg",width:"14",height:"16",viewBox:"0 0 14 16"}),Object(r.b)("path",Object(a.a)({parentName:"svg"},{fillRule:"evenodd",d:"M6.3 5.69a.942.942 0 0 1-.28-.7c0-.28.09-.52.28-.7.19-.18.42-.28.7-.28.28 0 .52.09.7.28.18.19.28.42.28.7 0 .28-.09.52-.28.7a1 1 0 0 1-.7.3c-.28 0-.52-.11-.7-.3zM8 7.99c-.02-.25-.11-.48-.31-.69-.2-.19-.42-.3-.69-.31H6c-.27.02-.48.13-.69.31-.2.2-.3.44-.31.69h1v3c.02.27.11.5.31.69.2.2.42.31.69.31h1c.27 0 .48-.11.69-.31.2-.19.3-.42.31-.69H8V7.98v.01zM7 2.3c-3.14 0-5.7 2.54-5.7 5.68 0 3.14 2.56 5.7 5.7 5.7s5.7-2.55 5.7-5.7c0-3.15-2.56-5.69-5.7-5.69v.01zM7 .98c3.86 0 7 3.14 7 7s-3.14 7-7 7-7-3.12-7-7 3.14-7 7-7z"})))),"Help needed for more runner!")),Object(r.b)("div",Object(a.a)({parentName:"div"},{className:"admonition-content"}),Object(r.b)("p",{parentName:"div"},"We intent on supporting more task runners: ",Object(r.b)("inlineCode",{parentName:"p"},"python-rq")," or ",Object(r.b)("inlineCode",{parentName:"p"},"celery"),", maybe even a custom one with just list of hosts to ",Object(r.b)("inlineCode",{parentName:"p"},"ssh")," into... Ideally we'll implement a couple integrations, then write integration docs and rely on the community. Maybe we can piggyback on ",Object(r.b)("inlineCode",{parentName:"p"},"joblib")," if other project provide distributed backend..."))),Object(r.b)("h3",{id:"dealing-with-existing-results"},"Dealing with existing results"),Object(r.b)("p",null,"When you try to re-run already existing results, The behaviour of ",Object(r.b)("inlineCode",{parentName:"p"},"qa batch")," can be changed with the ",Object(r.b)("inlineCode",{parentName:"p"},"--action-on-existing")," flag:"),Object(r.b)("ul",null,Object(r.b)("li",{parentName:"ul"},Object(r.b)("inlineCode",{parentName:"li"},"--action-on-existing=run"),": overwrite the old results (default)."),Object(r.b)("li",{parentName:"ul"},Object(r.b)("inlineCode",{parentName:"li"},"postprocess"),": only call the ",Object(r.b)("inlineCode",{parentName:"li"},"postprocess()")," function, not ",Object(r.b)("inlineCode",{parentName:"li"},"run()+postprocess()")," as usual. (Note: it's also provided by ",Object(r.b)("inlineCode",{parentName:"li"},"qa postprocess"),")"),Object(r.b)("li",{parentName:"ul"},Object(r.b)("inlineCode",{parentName:"li"},"sync"),": update the output file manifest and read metrics from ",Object(r.b)("em",{parentName:"li"},"$output_dir/metrics.json"),". (Note: it's also provided by ",Object(r.b)("inlineCode",{parentName:"li"},"qa sync"),")"),Object(r.b)("li",{parentName:"ul"},Object(r.b)("inlineCode",{parentName:"li"},"skip"),": do nothing")),Object(r.b)("hr",null),Object(r.b)("h2",{id:"connecting-to-a-custom-qa-board-instance"},"Connecting to a custom QA-Board instance"),Object(r.b)("p",null,"Use ",Object(r.b)("inlineCode",{parentName:"p"},"qa --offline")," to ensure you don't connect to a QA-Board instance. It's useful if... you don't have one (?).\nThe default connection settings can be overriden by environment variables. For example:"),Object(r.b)("pre",null,Object(r.b)("code",Object(a.a)({parentName:"pre"},{className:"language-bash"}),"export QABOARD_DB_PROTOCOL=http\nexport QABOARD_DB_HOST=qa\nexport QABOARD_DB_PORT=5000\n")))}p.isMDXComponent=!0},181:function(e,t,n){"use strict";n.d(t,"a",(function(){return p})),n.d(t,"b",(function(){return m}));var a=n(0),i=n.n(a);function r(e,t,n){return t in e?Object.defineProperty(e,t,{value:n,enumerable:!0,configurable:!0,writable:!0}):e[t]=n,e}function c(e,t){var n=Object.keys(e);if(Object.getOwnPropertySymbols){var a=Object.getOwnPropertySymbols(e);t&&(a=a.filter((function(t){return Object.getOwnPropertyDescriptor(e,t).enumerable}))),n.push.apply(n,a)}return n}function o(e){for(var t=1;t<arguments.length;t++){var n=null!=arguments[t]?arguments[t]:{};t%2?c(Object(n),!0).forEach((function(t){r(e,t,n[t])})):Object.getOwnPropertyDescriptors?Object.defineProperties(e,Object.getOwnPropertyDescriptors(n)):c(Object(n)).forEach((function(t){Object.defineProperty(e,t,Object.getOwnPropertyDescriptor(n,t))}))}return e}function l(e,t){if(null==e)return{};var n,a,i=function(e,t){if(null==e)return{};var n,a,i={},r=Object.keys(e);for(a=0;a<r.length;a++)n=r[a],t.indexOf(n)>=0||(i[n]=e[n]);return i}(e,t);if(Object.getOwnPropertySymbols){var r=Object.getOwnPropertySymbols(e);for(a=0;a<r.length;a++)n=r[a],t.indexOf(n)>=0||Object.prototype.propertyIsEnumerable.call(e,n)&&(i[n]=e[n])}return i}var b=i.a.createContext({}),s=function(e){var t=i.a.useContext(b),n=t;return e&&(n="function"==typeof e?e(t):o({},t,{},e)),n},p=function(e){var t=s(e.components);return i.a.createElement(b.Provider,{value:t},e.children)},d={inlineCode:"code",wrapper:function(e){var t=e.children;return i.a.createElement(i.a.Fragment,{},t)}},u=Object(a.forwardRef)((function(e,t){var n=e.components,a=e.mdxType,r=e.originalType,c=e.parentName,b=l(e,["components","mdxType","originalType","parentName"]),p=s(n),u=a,m=p["".concat(c,".").concat(u)]||p[u]||d[u]||r;return n?i.a.createElement(m,o({ref:t},b,{components:n})):i.a.createElement(m,o({ref:t},b))}));function m(e,t){var n=arguments,a=t&&t.mdxType;if("string"==typeof e||a){var r=n.length,c=new Array(r);c[0]=u;var o={};for(var l in t)hasOwnProperty.call(t,l)&&(o[l]=t[l]);o.originalType=e,o.mdxType="string"==typeof e?e:a,c[1]=o;for(var b=2;b<r;b++)c[b]=n[b];return i.a.createElement.apply(null,c)}return i.a.createElement.apply(null,n)}u.displayName="MDXCreateElement"},182:function(e,t,n){"use strict";var a=n(0),i=n(49);t.a=function(){return Object(a.useContext)(i.a)}},183:function(e,t,n){"use strict";n.d(t,"a",(function(){return i}));n(184);var a=n(182);function i(e){var t=(Object(a.a)().siteConfig||{}).baseUrl,n=void 0===t?"/":t;if(!e)return e;return/^(https?:|\/\/)/.test(e)?e:e.startsWith("/")?n+e.slice(1):n+e}},184:function(e,t,n){"use strict";var a=n(17),i=n(35),r=n(185),c="".startsWith;a(a.P+a.F*n(186)("startsWith"),"String",{startsWith:function(e){var t=r(this,e,"startsWith"),n=i(Math.min(arguments.length>1?arguments[1]:void 0,t.length)),a=String(e);return c?c.call(t,a,n):t.slice(n,n+a.length)===a}})},185:function(e,t,n){var a=n(70),i=n(23);e.exports=function(e,t,n){if(a(t))throw TypeError("String#"+n+" doesn't accept regex!");return String(i(e))}},186:function(e,t,n){var a=n(2)("match");e.exports=function(e){var t=/./;try{"/./"[e](t)}catch(n){try{return t[a]=!1,!"/./"[e](t)}catch(i){}}return!0}}}]);