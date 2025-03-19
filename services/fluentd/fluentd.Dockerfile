# fluentd/Dockerfile

FROM fluent/fluentd:v1.16.6-debian-1.0

USER root
# SIRC proxy configuration [debian/ubuntu]
# Copied from http://gitlab-srv/docker/drun/snippets/11/edit
# if you still run into network issues, try building the image on a different server :_)
ENV PROXY_HOST=webproxy.transchip.com \
        PROXY_PORT=8080 \
        PROXY_PROTOCOL=http
ENV PROXY $PROXY_PROTOCOL://$PROXY_HOST:$PROXY_PORT
RUN echo "Acquire::http::Proxy \"$PROXY\";" >> /etc/apt/apt.conf; \
    echo 'Acquire::https::Verify-Peer "false";' >> /etc/apt/apt.conf; \
    echo "[http]\nsslverify = false\n# proxy = $PROXY" >> /root/.gitconfig
# ollama uses HTTP for internal communication between client/server
# so they recommend not setting HTTP_PROXY, 
# but then we can't pull from the web UI because
#    https://github.com/open-webui/open-webui/blob/96c865404d36637eafadb6d2dd2365c85d452648/backend/open_webui/apps/ollama/main.py#L347
# this insecure flag makes t use http, and it ends up blocked because we didn't define HTTP_PROXY, since using that breaks the ollama CLI client when it tries to talk to its backend. lol... 
# So we really need to define HTTP_PROXY
ENV HTTP_PROXY=$PROXY \
    http_proxy=$PROXY
ENV HTTPS_PROXY=$PROXY \
    https_proxy=$PROXY \
    NO_PROXY='0.0.0.0,gitlab-srv,gitlab-srv.transchip.com,localhost,sentry,sentry.transchip.com'


RUN apt-get update -qq && \
    apt-get install ca-certificates wget -y && \
    wget http://itweb/downloads/sirc-ca.crt -P /usr/local/share/ca-certificates/ && \
    update-ca-certificates
ENV REQUESTS_CA_BUNDLE=/etc/ssl/certs/ca-certificates.crt

RUN apt-get install -y strace curl wget

# RUN ["gem", "install", "fluent-plugin-elasticsearch", "--no-document", "--version", "5.4.3"]
# RUN ["gem", "install", "fluent-plugin-concat", "--no-document", "--version", "2.5.0"]
RUN gem install fluent-plugin-elasticsearch:5.4.3 \
    fluent-plugin-concat:2.5.0 \
    fluent-plugin-grafana-loki --no-document

USER fluent
