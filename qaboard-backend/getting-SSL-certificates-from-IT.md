## Getting SSL certificates from IT
```bash
cd deployment/nginx/ssl/qa

# 1. Generate a key `.key`.
openssl genrsa -out qa.key 2048

# 2. Generate a certificate request `.csr`.
openssl req -new -sha256 -key qa.key -out qa.csr -config qa.csr.conf
# Accept all the defaults:
# - Country Name: IL
# - State or Province Name: Israel
# - Locality Name: Ramat Gan
# - Organization Name: Samsung
# - Organizational Unit Name: SIRC
# - Common Name: *.qa
# - Email: arthur.flam@samsung.com
# - Password: (empty)
# - Optionnal Company Name: (empty)

# Check all is good.
openssl req -noout -text -in qa.csr

# 3. Send the CSR to IT.
# 4. They will give you a `.cer` certificate. Convert it to `.pem` with 
openssl x509 -in dvs.cer -inform der -outform pem -out qa.pem

# 5. Now you can configure your server to use qa.key and qa.pem
```

References:

- [nginx configuration](http://nginx.org/en/docs/http/configuring_https_servers.html)
- [multiname certificates](https://stackoverflow.com/questions/23523456/how-to-give-a-multiline-certificate-name-cn-for-a-certificate-generated-using)
