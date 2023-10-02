FROM metabase/metabase:latest


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
ENV HTTP_PROXY=$PROXY \
    http_proxy=$PROXY \
    HTTPS_PROXY=$PROXY \
    https_proxy=$PROXY \
    NO_PROXY='qa,gitlab-srv,gitlab-srv.transchip.com,localhost,aospt-dt,sentry,sentry.transchip.com'


COPY services/GlobalSign.crt /usr/local/share/ca-certificates/GlobalSign.crt
RUN wget http://itweb/downloads/sirc-ca.crt -P /usr/local/share/ca-certificates

RUN keytool -import -alias cacert -storepass changeit \
    -keystore cacerts.jks \
    -noprompt \
    -file /usr/local/share/ca-certificates/GlobalSign.crt
# RUN keytool -import -alias cacert -storepass changeit \
#     -keystore cacerts.jks \
#     -noprompt \
#     -file /usr/local/share/ca-certificates/sirc-ca.crt
# RUN ls
# RUN ${JAVA_HOME}/bin/keytool -importcert -v -trustcacerts \
#     -alias metabase \
#     -file "/usr/local/share/ca-certificates/sirc-ca.crt" \
#     # -keystore ${JAVA_HOME}/jre/lib/security/cacerts \
#     # -keystore /usr/lib/jvm/default-jvm/jre/lib/security/cacerts \
#     -storepass changeit -noprompt
ENV JAVA_TOOL_OPTIONS "-Dtrust_all_cert=true -Djavax.net.ssl.trustStore=cacerts.jks -Djavax.net.ssl.trustStorePassword=changeit -Dhttps.proxyHost=webproxy.transchip.com -Dhttps.proxyPort=8080 -Dhttp.proxyHost=webproxy.transchip.com -Dhttp.proxyPort=8080"
# CMD ["java", "-Djavax.net.ssl.trustStore=cacerts.jks", "-Dhttps.proxyHost=webproxy.transchip.com", "-Dhttps.proxyPort=8080", "-Dhttp.proxyHost=webproxy.transchip.com", "-Dhttp.proxyPort=8080",  "-Djavax.net.ssl.trustStorePassword=changeit", "-jar",  "metabase.jar"]
