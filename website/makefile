


.PHONY: build publish publish-http

build:
	NO_PROXY=localhost PORT=7000 NODE_TLS_REJECT_UNAUTHORIZED=0 DANGEROUSLY_DISABLE_HOST_CHECK=true REACT_EDITOR=subl HOST=0.0.0.0 yarn build && rm -rf build_qadocs && \cp -rf build build_qadocs &&  \cp -rf static/index.html build_qadocs/qatools


# https://docusaurus.io/docs/en/publishing
publish:
	PUBLISH=korea DEPLOYMENT_BRANCH=gh-pages GITHUB_HOST=github.sec.samsung.net USE_SSH=true GIT_USER=git NO_PROXY=localhost PORT=7000 NODE_TLS_REJECT_UNAUTHORIZED=0 DANGEROUSLY_DISABLE_HOST_CHECK=true REACT_EDITOR=subl HOST=0.0.0.0 yarn publish-gh-pages

publish-http:
	PUBLISH=korea DEPLOYMENT_BRANCH=gh-pages GITHUB_HOST=github.sec.samsung.net GIT_USER=arthur-flam NO_PROXY=localhost PORT=7000 NODE_TLS_REJECT_UNAUTHORIZED=0 DANGEROUSLY_DISABLE_HOST_CHECK=true REACT_EDITOR=subl HOST=0.0.0.0 yarn publish-gh-pages
