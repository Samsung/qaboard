


.PHONY: build publish publish-http

build:
	NO_PROXY=localhost PORT=7000 NODE_TLS_REJECT_UNAUTHORIZED=0 DANGEROUSLY_DISABLE_HOST_CHECK=true HOST=0.0.0.0 yarn build && rm -rf build_qadocs && \cp -rf build build_qadocs


# https://docusaurus.io/docs/en/publishing
publish:
	PUBLISH=github_samsung_private DEPLOYMENT_BRANCH=gh-pages GITHUB_HOST=github.sec.samsung.net USE_SSH=true GIT_USER=git NO_PROXY=localhost PORT=7000 NODE_TLS_REJECT_UNAUTHORIZED=0 DANGEROUSLY_DISABLE_HOST_CHECK=true REACT_EDITOR=subl HOST=0.0.0.0 yarn deploy

publish-http:
	PUBLISH=github_samsung_private DEPLOYMENT_BRANCH=gh-pages GITHUB_HOST=github.sec.samsung.net GIT_USER=arthur-flam NO_PROXY=localhost PORT=7000 NODE_TLS_REJECT_UNAUTHORIZED=0 DANGEROUSLY_DISABLE_HOST_CHECK=true REACT_EDITOR=subl HOST=0.0.0.0 yarn deploy

publish-public:
	# ssh
	# PUBLISH=github_samsung_public DEPLOYMENT_BRANCH=gh-pages GITHUB_HOST=github.com USE_SSH=true GIT_USER=git NO_PROXY=localhost PORT=7000 NODE_TLS_REJECT_UNAUTHORIZED=0 DANGEROUSLY_DISABLE_HOST_CHECK=true REACT_EDITOR=subl HOST=0.0.0.0 yarn deploy
	# http
	PUBLISH=github_samsung_public DEPLOYMENT_BRANCH=gh-pages GITHUB_HOST=github.com GIT_USER=arthur-flam NO_PROXY=localhost PORT=7000 NODE_TLS_REJECT_UNAUTHORIZED=0 DANGEROUSLY_DISABLE_HOST_CHECK=true REACT_EDITOR=subl HOST=0.0.0.0 yarn deploy
