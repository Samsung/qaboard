FROM mher/flower
USER root


# SIRC proxy configuration [debian/ubuntu]
# Copied from http://gitlab-srv/docker/drun/snippets/11/edit
# if you still run into network issues, try building the image on a different server :_)
ENV PROXY_HOST=webproxy.transchip.com \
        PROXY_PORT=8080 \
        PROXY_PROTOCOL=http
ENV PROXY $PROXY_PROTOCOL://$PROXY_HOST:$PROXY_PORT
# RUN echo "Acquire::http::Proxy \"$PROXY\";" >> /etc/apt/apt.conf; \
#     echo 'Acquire::https::Verify-Peer "false";' >> /etc/apt/apt.conf; \
#     echo "[http]\nsslverify = false\n# proxy = $PROXY" >> /root/.gitconfig
ENV HTTP_PROXY=$PROXY \
    http_proxy=$PROXY \
    HTTPS_PROXY=$PROXY \
    https_proxy=$PROXY \
    NO_PROXY='gitlab-srv,gitlab-srv.transchip.com,localhost,aospt-dt,sentry,sentry.transchip.com'

RUN echo "[global]\ntrusted-host = pypi.python.org\n pypi.org\n files.pythonhosted.org\n download.pytorch.org\n github.com\n objects.githubusercontent.com\n" > /etc/pip.conf

# RUN apt-get update -qq && \
#     apt-get install ca-certificates wget -y && \
#     wget http://itweb/downloads/sirc-ca.crt -P /usr/local/share/ca-certificates/ && \
#     update-ca-certificates

COPY . /qaboard
# we don't need cde-python, or scientific libs and anyway we don't have git/ssh...
RUN sed -E -i "s/'(cde|scikit).*//g" /qaboard/setup.py
RUN sed -E -i "s/from cde.*//g" /qaboard/qaboard/utils.py

RUN pip install /qaboard

USER flower
