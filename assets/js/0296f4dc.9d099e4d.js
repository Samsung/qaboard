"use strict";(self.webpackChunkApache_2_0=self.webpackChunkApache_2_0||[]).push([[1922],{3905:function(e,t,a){a.d(t,{Zo:function(){return d},kt:function(){return m}});var r=a(7294);function n(e,t,a){return t in e?Object.defineProperty(e,t,{value:a,enumerable:!0,configurable:!0,writable:!0}):e[t]=a,e}function o(e,t){var a=Object.keys(e);if(Object.getOwnPropertySymbols){var r=Object.getOwnPropertySymbols(e);t&&(r=r.filter((function(t){return Object.getOwnPropertyDescriptor(e,t).enumerable}))),a.push.apply(a,r)}return a}function i(e){for(var t=1;t<arguments.length;t++){var a=null!=arguments[t]?arguments[t]:{};t%2?o(Object(a),!0).forEach((function(t){n(e,t,a[t])})):Object.getOwnPropertyDescriptors?Object.defineProperties(e,Object.getOwnPropertyDescriptors(a)):o(Object(a)).forEach((function(t){Object.defineProperty(e,t,Object.getOwnPropertyDescriptor(a,t))}))}return e}function l(e,t){if(null==e)return{};var a,r,n=function(e,t){if(null==e)return{};var a,r,n={},o=Object.keys(e);for(r=0;r<o.length;r++)a=o[r],t.indexOf(a)>=0||(n[a]=e[a]);return n}(e,t);if(Object.getOwnPropertySymbols){var o=Object.getOwnPropertySymbols(e);for(r=0;r<o.length;r++)a=o[r],t.indexOf(a)>=0||Object.prototype.propertyIsEnumerable.call(e,a)&&(n[a]=e[a])}return n}var s=r.createContext({}),c=function(e){var t=r.useContext(s),a=t;return e&&(a="function"==typeof e?e(t):i(i({},t),e)),a},d=function(e){var t=c(e.components);return r.createElement(s.Provider,{value:t},e.children)},p={inlineCode:"code",wrapper:function(e){var t=e.children;return r.createElement(r.Fragment,{},t)}},u=r.forwardRef((function(e,t){var a=e.components,n=e.mdxType,o=e.originalType,s=e.parentName,d=l(e,["components","mdxType","originalType","parentName"]),u=c(a),m=n,g=u["".concat(s,".").concat(m)]||u[m]||p[m]||o;return a?r.createElement(g,i(i({ref:t},d),{},{components:a})):r.createElement(g,i({ref:t},d))}));function m(e,t){var a=arguments,n=t&&t.mdxType;if("string"==typeof e||n){var o=a.length,i=new Array(o);i[0]=u;var l={};for(var s in t)hasOwnProperty.call(t,s)&&(l[s]=t[s]);l.originalType=e,l.mdxType="string"==typeof e?e:n,i[1]=l;for(var c=2;c<o;c++)i[c]=a[c];return r.createElement.apply(null,i)}return r.createElement.apply(null,a)}u.displayName="MDXCreateElement"},9242:function(e,t,a){a.r(t),a.d(t,{frontMatter:function(){return l},contentTitle:function(){return s},metadata:function(){return c},toc:function(){return d},default:function(){return u}});var r=a(7462),n=a(3366),o=(a(7294),a(3905)),i=["components"],l={id:"celery-integration",title:"Using celery as a task runner",sidebar_label:"Celery Integration"},s=void 0,c={unversionedId:"celery-integration",id:"celery-integration",title:"Using celery as a task runner",description:"Celery is a simple, flexible, and reliable distributed task queue.",source:"@site/docs/celery-integration.md",sourceDirName:".",slug:"/celery-integration",permalink:"/qaboard/docs/celery-integration",editUrl:"https://github.com/Samsung/qaboard/edit/master/website/docs/docs/celery-integration.md",tags:[],version:"current",frontMatter:{id:"celery-integration",title:"Using celery as a task runner",sidebar_label:"Celery Integration"},sidebar:"docs",previous:{title:"Local Multiprocessing",permalink:"/qaboard/docs/local-multiprocessing"},next:{title:"LSF Integration",permalink:"/qaboard/docs/lsf-integration"}},d=[{value:"Starting Celery workers",id:"starting-celery-workers",children:[],level:2},{value:"Monitoring",id:"monitoring",children:[],level:2},{value:"Advanced Celery Configuration",id:"advanced-celery-configuration",children:[],level:2}],p={toc:d};function u(e){var t=e.components,a=(0,n.Z)(e,i);return(0,o.kt)("wrapper",(0,r.Z)({},p,a,{components:t,mdxType:"MDXLayout"}),(0,o.kt)("p",null,(0,o.kt)("a",{parentName:"p",href:"http://docs.celeryproject.org/en/latest/index.html"},"Celery")," is a simple, flexible, and reliable distributed task queue."),(0,o.kt)("h2",{id:"starting-celery-workers"},"Starting Celery workers"),(0,o.kt)("ol",null,(0,o.kt)("li",{parentName:"ol"},"To manage the task queue we'll need what they call a ",(0,o.kt)("em",{parentName:"li"},"broker"),". The QA-Board server already starts one on port ",(0,o.kt)("inlineCode",{parentName:"li"},"5672"),". If you want to start another one, it's easy:")),(0,o.kt)("pre",null,(0,o.kt)("code",{parentName:"pre",className:"language-bash"},"docker run --detach -p 5672:5672 rabbitmq\n#=> runs in the background\n")),(0,o.kt)("ol",{start:2},(0,o.kt)("li",{parentName:"ol"},"Next you need to start at least a ",(0,o.kt)("em",{parentName:"li"},"worker")," that will execute async tasks:")),(0,o.kt)("pre",null,(0,o.kt)("code",{parentName:"pre",className:"language-bash"},"# need python3\npip install celery qaboard\ncelery -A qaboard.runners.celery_app worker --concurrency=10 --loglevel=info\n")),(0,o.kt)("div",{className:"admonition admonition-note alert alert--secondary"},(0,o.kt)("div",{parentName:"div",className:"admonition-heading"},(0,o.kt)("h5",{parentName:"div"},(0,o.kt)("span",{parentName:"h5",className:"admonition-icon"},(0,o.kt)("svg",{parentName:"span",xmlns:"http://www.w3.org/2000/svg",width:"14",height:"16",viewBox:"0 0 14 16"},(0,o.kt)("path",{parentName:"svg",fillRule:"evenodd",d:"M6.3 5.69a.942.942 0 0 1-.28-.7c0-.28.09-.52.28-.7.19-.18.42-.28.7-.28.28 0 .52.09.7.28.18.19.28.42.28.7 0 .28-.09.52-.28.7a1 1 0 0 1-.7.3c-.28 0-.52-.11-.7-.3zM8 7.99c-.02-.25-.11-.48-.31-.69-.2-.19-.42-.3-.69-.31H6c-.27.02-.48.13-.69.31-.2.2-.3.44-.31.69h1v3c.02.27.11.5.31.69.2.2.42.31.69.31h1c.27 0 .48-.11.69-.31.2-.19.3-.42.31-.69H8V7.98v.01zM7 2.3c-3.14 0-5.7 2.54-5.7 5.68 0 3.14 2.56 5.7 5.7 5.7s5.7-2.55 5.7-5.7c0-3.15-2.56-5.69-5.7-5.69v.01zM7 .98c3.86 0 7 3.14 7 7s-3.14 7-7 7-7-3.12-7-7 3.14-7 7-7z"}))),"note")),(0,o.kt)("div",{parentName:"div",className:"admonition-content"},(0,o.kt)("p",{parentName:"div"},"Ideally we should run workers as daemons to handle failures, reboots... ",(0,o.kt)("a",{parentName:"p",href:"https://docs.celeryproject.org/en/stable/userguide/daemonizing.html"},"Read the docs")," to do it nicely... Currently we just use ",(0,o.kt)("inlineCode",{parentName:"p"},"screen"),":"),(0,o.kt)("pre",{parentName:"div"},(0,o.kt)("code",{parentName:"pre",className:"language-bash"},"sudo apt-get install screen\nscreen -dmS qaboard-worker-01 <celery-command>\n")))),(0,o.kt)("ol",{start:3},(0,o.kt)("li",{parentName:"ol"},"To have ",(0,o.kt)("inlineCode",{parentName:"li"},"qa batch")," use Celery runners, just  configure:")),(0,o.kt)("pre",null,(0,o.kt)("code",{parentName:"pre",className:"language-yaml",metastring:'title="qaboard.yaml"',title:'"qaboard.yaml"'},'runners:\n  default: celery\n  # by default we assume you QA-Board server hostname is qaboard...\n  # to change it (for example to "localhost", where QA-Board might be running), define:\n  celery:\n    broker_url: pyamqp://guest:guest@localhost:5672//  # also read from the ENV variable CELERY_BROKER_URL\n')),(0,o.kt)("div",{className:"admonition admonition-tip alert alert--success"},(0,o.kt)("div",{parentName:"div",className:"admonition-heading"},(0,o.kt)("h5",{parentName:"div"},(0,o.kt)("span",{parentName:"h5",className:"admonition-icon"},(0,o.kt)("svg",{parentName:"span",xmlns:"http://www.w3.org/2000/svg",width:"12",height:"16",viewBox:"0 0 12 16"},(0,o.kt)("path",{parentName:"svg",fillRule:"evenodd",d:"M6.5 0C3.48 0 1 2.19 1 5c0 .92.55 2.25 1 3 1.34 2.25 1.78 2.78 2 4v1h5v-1c.22-1.22.66-1.75 2-4 .45-.75 1-2.08 1-3 0-2.81-2.48-5-5.5-5zm3.64 7.48c-.25.44-.47.8-.67 1.11-.86 1.41-1.25 2.06-1.45 3.23-.02.05-.02.11-.02.17H5c0-.06 0-.13-.02-.17-.2-1.17-.59-1.83-1.45-3.23-.2-.31-.42-.67-.67-1.11C2.44 6.78 2 5.65 2 5c0-2.2 2.02-4 4.5-4 1.22 0 2.36.42 3.22 1.19C10.55 2.94 11 3.94 11 5c0 .66-.44 1.78-.86 2.48zM4 14h5c-.23 1.14-1.3 2-2.5 2s-2.27-.86-2.5-2z"}))),"tip")),(0,o.kt)("div",{parentName:"div",className:"admonition-content"},(0,o.kt)("p",{parentName:"div"},"You can choose on the CLI what runner you want: "),(0,o.kt)("pre",{parentName:"div"},(0,o.kt)("code",{parentName:"pre",className:"language-bash"},"qa batch --runner=celery my-batch\n# can be useful to see real-time logs in the CLI...\nqa batch --runner=local my-batch\n")))),(0,o.kt)("p",null,"Note that unless you have a transparent shared storage for your working directory, you'll need to use ",(0,o.kt)("inlineCode",{parentName:"p"},"qa --share batch")," to see runs in QA-Board..."),(0,o.kt)("h2",{id:"monitoring"},"Monitoring"),(0,o.kt)("ul",null,(0,o.kt)("li",{parentName:"ul"},"A ",(0,o.kt)("a",{parentName:"li",href:"https://flower.readthedocs.io/en/latest/"},(0,o.kt)("inlineCode",{parentName:"a"},"flower"))," instance is available at ",(0,o.kt)("inlineCode",{parentName:"li"},"<QABOARD_HOST>/flower")),(0,o.kt)("li",{parentName:"ul"},"Read the ",(0,o.kt)("a",{parentName:"li",href:"http://docs.celeryproject.org/en/latest/userguide/monitoring.html"},"docs"),".")),(0,o.kt)("h2",{id:"advanced-celery-configuration"},"Advanced Celery Configuration"),(0,o.kt)("p",null,"To configure Celery at the ",(0,o.kt)("strong",{parentName:"p"},"project level"),":"),(0,o.kt)("pre",null,(0,o.kt)("code",{parentName:"pre",className:"language-yaml",metastring:'title="qaboard.yaml"',title:'"qaboard.yaml"'},'runners:\n  default: celery\n  celery:\n    # assuming your QA-Board server\'s hostname is qaboard\n    broker_url: pyamqp://guest:guest@qaboard:5672//  # also read from ENV vars with CELERY_BROKER_URL\n    result_backend: rpc://                  # also read from ENV vars with CELERY_RESULT_BACKEND\n    # To know all the options and tweak priorities, rate-limiting... Read:\n    # http://docs.celeryproject.org/en/latest/getting-started/first-steps-with-celery.html#configuration\n    # http://docs.celeryproject.org/en/latest/userguide/configuration.html#configuration\n    # For example:\n    timezone: Europe/Paris\n\n    # By default tasks will be named "qaboard" unless you define\n    qaboard_task_name: qaboard\n')),(0,o.kt)("p",null,"It's often useful to give ",(0,o.kt)("strong",{parentName:"p"},"batches")," their own settings. For instance you may want to use different queues if you manage different types of resources (GPUs, Windows/Linux/Android...):"),(0,o.kt)("pre",null,(0,o.kt)("code",{parentName:"pre",className:"language-bash"},"# On a server with a GPU:\ncelery -A qaboard.runners.celery_app worker --concurrency=1 --queues gpu,large-gpu\n")),(0,o.kt)("pre",null,(0,o.kt)("code",{parentName:"pre",className:"language-yaml",metastring:'{7-9} title="qa/batches.yaml"',"{7-9}":!0,title:'"qa/batches.yaml"'},"my-batch-that-needs-a-gpu:\n  inputs:\n  - my/training/images\n  configuration:\n  - hyperparams.yaml\n  celery:\n    task_routes:\n      qaboard: gpu\n")),(0,o.kt)("div",{className:"admonition admonition-tip alert alert--success"},(0,o.kt)("div",{parentName:"div",className:"admonition-heading"},(0,o.kt)("h5",{parentName:"div"},(0,o.kt)("span",{parentName:"h5",className:"admonition-icon"},(0,o.kt)("svg",{parentName:"span",xmlns:"http://www.w3.org/2000/svg",width:"12",height:"16",viewBox:"0 0 12 16"},(0,o.kt)("path",{parentName:"svg",fillRule:"evenodd",d:"M6.5 0C3.48 0 1 2.19 1 5c0 .92.55 2.25 1 3 1.34 2.25 1.78 2.78 2 4v1h5v-1c.22-1.22.66-1.75 2-4 .45-.75 1-2.08 1-3 0-2.81-2.48-5-5.5-5zm3.64 7.48c-.25.44-.47.8-.67 1.11-.86 1.41-1.25 2.06-1.45 3.23-.02.05-.02.11-.02.17H5c0-.06 0-.13-.02-.17-.2-1.17-.59-1.83-1.45-3.23-.2-.31-.42-.67-.67-1.11C2.44 6.78 2 5.65 2 5c0-2.2 2.02-4 4.5-4 1.22 0 2.36.42 3.22 1.19C10.55 2.94 11 3.94 11 5c0 .66-.44 1.78-.86 2.48zM4 14h5c-.23 1.14-1.3 2-2.5 2s-2.27-.86-2.5-2z"}))),"tip")),(0,o.kt)("div",{parentName:"div",className:"admonition-content"},(0,o.kt)("p",{parentName:"div"},"Read ",(0,o.kt)("a",{parentName:"p",href:"http://docs.celeryproject.org/en/latest/getting-started/first-steps-with-celery.html"},"Celery's tutorial")))),(0,o.kt)("p",null,"Celery's ",(0,o.kt)("a",{parentName:"p",href:"https://docs.celeryproject.org/en/stable/userguide/workers.html"},"worker user guide")," has lots of information on how to run ",(0,o.kt)("a",{parentName:"p",href:"https://docs.celeryproject.org/en/stable/userguide/daemonizing.html#daemonizing"},"worker in the background"),", set ",(0,o.kt)("a",{parentName:"p",href:"https://docs.celeryproject.org/en/stable/userguide/workers.html#concurrency"},"concurrency"),"... Check it out too as needed!"))}u.isMDXComponent=!0}}]);