(window.webpackJsonp=window.webpackJsonp||[]).push([[45],{178:function(e,t,a){"use strict";a.r(t),a.d(t,"frontMatter",(function(){return i})),a.d(t,"metadata",(function(){return l})),a.d(t,"rightToc",(function(){return c})),a.d(t,"default",(function(){return d}));var n=a(1),r=a(9),o=(a(0),a(184)),i={id:"deleting-old-data",sidebar_label:"Deleting Old Data",title:"Deleting Old Outputs and Artifacts"},l={id:"deleting-old-data",title:"Deleting Old Outputs and Artifacts",description:"QA-Board lets you erase old outputs after a period of time.\r",source:"@site/docs/deleting-old-data.md",permalink:"/qaboard/docs/deleting-old-data",sidebar_label:"Deleting Old Data",sidebar:"docs",previous:{title:"Integrating QA-Board with your CI",permalink:"/qaboard/docs/ci-integration"},next:{title:"Defining Pipelines / DAG",permalink:"/qaboard/docs/dag-pipelines"}},c=[{value:"What data will <em>not</em> be deleted",id:"what-data-will-not-be-deleted",children:[]},{value:"Configuring garbage collection",id:"configuring-garbage-collection",children:[]},{value:"Recovering lost data?",id:"recovering-lost-data",children:[]},{value:"Deleting commit artifacts",id:"deleting-commit-artifacts",children:[]}],b={rightToc:c};function d(e){var t=e.components,a=Object(r.a)(e,["components"]);return Object(o.b)("wrapper",Object(n.a)({},b,a,{components:t,mdxType:"MDXLayout"}),Object(o.b)("p",null,"QA-Board lets you erase old outputs after a period of time."),Object(o.b)("h2",{id:"what-data-will-not-be-deleted"},"What data will ",Object(o.b)("em",{parentName:"h2"},"not")," be deleted"),Object(o.b)("p",null,"Outputs from commits that are either:"),Object(o.b)("ul",null,Object(o.b)("li",{parentName:"ul"},"Recent (more info below)"),Object(o.b)("li",{parentName:"ul"},"On the ",Object(o.b)("inlineCode",{parentName:"li"},"project.reference_branch")," from ",Object(o.b)("em",{parentName:"li"},"qaboard.yaml"),"."),Object(o.b)("li",{parentName:"ul"},"Are on a ",Object(o.b)("strong",{parentName:"li"},"commit/tag/branch")," listed as a ",Object(o.b)("inlineCode",{parentName:"li"},"project.milestones")," in ",Object(o.b)("em",{parentName:"li"},"qaboard.yaml"),"."),Object(o.b)("li",{parentName:"ul"},"Are a milestone defined from QA-Board's UI.")),Object(o.b)("div",{className:"admonition admonition-caution alert alert--warning"},Object(o.b)("div",Object(n.a)({parentName:"div"},{className:"admonition-heading"}),Object(o.b)("h5",{parentName:"div"},Object(o.b)("div",Object(n.a)({parentName:"h5"},{className:"admonition-icon"}),Object(o.b)("svg",Object(n.a)({parentName:"div"},{xmlns:"http://www.w3.org/2000/svg",width:"16",height:"16",viewBox:"0 0 16 16"}),Object(o.b)("path",Object(n.a)({parentName:"svg"},{fillRule:"evenodd",d:"M8.893 1.5c-.183-.31-.52-.5-.887-.5s-.703.19-.886.5L.138 13.499a.98.98 0 0 0 0 1.001c.193.31.53.501.886.501h13.964c.367 0 .704-.19.877-.5a1.03 1.03 0 0 0 .01-1.002L8.893 1.5zm.133 11.497H6.987v-2.003h2.039v2.003zm0-3.004H6.987V5.987h2.039v4.006z"})))),"caution")),Object(o.b)("div",Object(n.a)({parentName:"div"},{className:"admonition-content"}),Object(o.b)("p",{parentName:"div"},"QA-Board will set as a commit's branch the first it was seen on. If you merge with fast-forward rebased branches, then this information will not be what you expect. "))),Object(o.b)("h2",{id:"configuring-garbage-collection"},"Configuring garbage collection"),Object(o.b)("p",null,"Data can be erased after a period of time where the commit has no new outputs."),Object(o.b)("pre",null,Object(o.b)("code",Object(n.a)({parentName:"pre"},{className:"language-yaml"}),"# qaboard.yaml\nstorage:\n  garbage:\n    after: 1month\n")),Object(o.b)("p",null,Object(o.b)("inlineCode",{parentName:"p"},"after:")," supports human-readable values like ",Object(o.b)("em",{parentName:"p"},"2weeks"),", ",Object(o.b)("em",{parentName:"p"},"1year"),", ",Object(o.b)("em",{parentName:"p"},"3months"),"..."),Object(o.b)("h2",{id:"recovering-lost-data"},"Recovering lost data?"),Object(o.b)("p",null,"Well, you won't be able to do that. What you should try to do is make everything ",Object(o.b)("strong",{parentName:"p"},"reproducable"),"."),Object(o.b)("ul",null,Object(o.b)("li",{parentName:"ul"},"Define your whole ",Object(o.b)("em",{parentName:"li"},"environment as code"),". Make sure your commits contain 100% of what is needed for your code to run. Tools you can use include ",Object(o.b)("inlineCode",{parentName:"li"},"docker+Dockerfile"),", etc."),Object(o.b)("li",{parentName:"ul"},"Make it easy to re-trigger your CI, so that it's straightfoward to re-builds, re-run your tests, and uploads artifacts to QA-Board."),Object(o.b)("li",{parentName:"ul"},"If necessary, make it also very easy to run manually something like")),Object(o.b)("pre",null,Object(o.b)("code",Object(n.a)({parentName:"pre"},{className:"language-bash"}),"git checkout $hexsha\nmake\nqa save-artifacts\nqa batch my-batch\n")),Object(o.b)("h2",{id:"deleting-commit-artifacts"},"Deleting commit artifacts"),Object(o.b)("p",null,Object(o.b)("strong",{parentName:"p"},"Artifacts")," are not deleted by default, you have to ask for it:"),Object(o.b)("pre",null,Object(o.b)("code",Object(n.a)({parentName:"pre"},{className:"language-yaml",metastring:"{4,5}","{4,5}":!0}),"storage:\n  garbage:\n    after: 1month\n    artifacts:\n      delete: true\n")),Object(o.b)("p",null,'If you want to keep some artifacts (maybe "small" coverage reports defined as ',Object(o.b)("inlineCode",{parentName:"p"},"coverage_report: ...")," in ",Object(o.b)("em",{parentName:"p"},"qaboard.yaml"),"'s artifacts)"),Object(o.b)("pre",null,Object(o.b)("code",Object(n.a)({parentName:"pre"},{className:"language-yaml",metastring:"{6-7}","{6-7}":!0}),"storage:\n  garbage:\n    after: 1month\n    artifacts:\n      delete: true\n      keep:\n      - coverage_report\n      # also supports relative artifacts paths, e.g.\n      - build/my_binary\n")),Object(o.b)("p",null,"Notes:"),Object(o.b)("ul",null,Object(o.b)("li",{parentName:"ul"},"The settings that are used are those in the latest commit of the ",Object(o.b)("inlineCode",{parentName:"li"},"reference_branch")," defined in ",Object(o.b)("em",{parentName:"li"},"qaboard.yaml")," "),Object(o.b)("li",{parentName:"ul"},"If you change those settings, artifacts for already deleted commits don't get deleted."),Object(o.b)("li",{parentName:"ul"},"When a ",Object(o.b)("inlineCode",{parentName:"li"},"qa run")," uses a commit that was deleted, or if you upload manifests for a deleted commit, it is marked as undeleted.")))}d.isMDXComponent=!0},184:function(e,t,a){"use strict";a.d(t,"a",(function(){return s})),a.d(t,"b",(function(){return p}));var n=a(0),r=a.n(n);function o(e,t,a){return t in e?Object.defineProperty(e,t,{value:a,enumerable:!0,configurable:!0,writable:!0}):e[t]=a,e}function i(e,t){var a=Object.keys(e);if(Object.getOwnPropertySymbols){var n=Object.getOwnPropertySymbols(e);t&&(n=n.filter((function(t){return Object.getOwnPropertyDescriptor(e,t).enumerable}))),a.push.apply(a,n)}return a}function l(e){for(var t=1;t<arguments.length;t++){var a=null!=arguments[t]?arguments[t]:{};t%2?i(Object(a),!0).forEach((function(t){o(e,t,a[t])})):Object.getOwnPropertyDescriptors?Object.defineProperties(e,Object.getOwnPropertyDescriptors(a)):i(Object(a)).forEach((function(t){Object.defineProperty(e,t,Object.getOwnPropertyDescriptor(a,t))}))}return e}function c(e,t){if(null==e)return{};var a,n,r=function(e,t){if(null==e)return{};var a,n,r={},o=Object.keys(e);for(n=0;n<o.length;n++)a=o[n],t.indexOf(a)>=0||(r[a]=e[a]);return r}(e,t);if(Object.getOwnPropertySymbols){var o=Object.getOwnPropertySymbols(e);for(n=0;n<o.length;n++)a=o[n],t.indexOf(a)>=0||Object.prototype.propertyIsEnumerable.call(e,a)&&(r[a]=e[a])}return r}var b=r.a.createContext({}),d=function(e){var t=r.a.useContext(b),a=t;return e&&(a="function"==typeof e?e(t):l({},t,{},e)),a},s=function(e){var t=d(e.components);return r.a.createElement(b.Provider,{value:t},e.children)},m={inlineCode:"code",wrapper:function(e){var t=e.children;return r.a.createElement(r.a.Fragment,{},t)}},u=Object(n.forwardRef)((function(e,t){var a=e.components,n=e.mdxType,o=e.originalType,i=e.parentName,b=c(e,["components","mdxType","originalType","parentName"]),s=d(a),u=n,p=s["".concat(i,".").concat(u)]||s[u]||m[u]||o;return a?r.a.createElement(p,l({ref:t},b,{components:a})):r.a.createElement(p,l({ref:t},b))}));function p(e,t){var a=arguments,n=t&&t.mdxType;if("string"==typeof e||n){var o=a.length,i=new Array(o);i[0]=u;var l={};for(var c in t)hasOwnProperty.call(t,c)&&(l[c]=t[c]);l.originalType=e,l.mdxType="string"==typeof e?e:n,i[1]=l;for(var b=2;b<o;b++)i[b]=a[b];return r.a.createElement.apply(null,i)}return r.a.createElement.apply(null,a)}u.displayName="MDXCreateElement"}}]);