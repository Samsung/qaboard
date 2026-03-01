FROM mher/flower
USER root

# Proxy/cert configuration — no-ops when args are empty (open-source builds)
ARG PROXY_URL=""
ARG NO_PROXY=""

ENV HTTP_PROXY=${PROXY_URL} http_proxy=${PROXY_URL} \
    HTTPS_PROXY=${PROXY_URL} https_proxy=${PROXY_URL} \
    NO_PROXY=${NO_PROXY}

RUN if [ -n "$PROXY_URL" ]; then \
      echo "[global]\ntrusted-host = pypi.python.org\n pypi.org\n files.pythonhosted.org\n download.pytorch.org\n github.com\n objects.githubusercontent.com\n" > /etc/pip.conf; \
    fi

COPY . /qaboard
# we don't need cde-python, or scientific libs and anyway we don't have git/ssh...
RUN sed -E -i "s/'(cde|scikit).*//g" /qaboard/setup.py
RUN sed -E -i "s/from cde.*//g" /qaboard/qaboard/utils.py

RUN pip install /qaboard

USER flower
