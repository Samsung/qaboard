{{- define "qaboard.fullname" -}}
{{- if contains .Chart.Name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name .Chart.Name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}

{{- define "qaboard.labels" -}}
app.kubernetes.io/name: {{ .Chart.Name }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Values.image.version | default .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version }}
{{- end -}}

{{/* Usage: include "qaboard.selectorLabels" (list . "backend") */}}
{{- define "qaboard.selectorLabels" -}}
{{- $ := index . 0 -}}
app.kubernetes.io/name: {{ $.Chart.Name }}
app.kubernetes.io/instance: {{ $.Release.Name }}
app.kubernetes.io/component: {{ index . 1 }}
{{- end -}}

{{/* The version of the images: image.version, else the chart's appVersion. Empty for "latest". */}}
{{- define "qaboard.imageVersion" -}}
{{- $version := .Values.image.version | default .Chart.AppVersion | toString -}}
{{- if ne $version "latest" -}}
{{ $version }}
{{- end -}}
{{- end -}}

{{/* Usage: include "qaboard.image" (list . "backend") */}}
{{- define "qaboard.image" -}}
{{- $ := index . 0 -}}
{{- $service := index . 1 -}}
{{- $version := include "qaboard.imageVersion" $ -}}
{{ $.Values.image.repository }}:{{ $service }}{{ if $version }}-{{ $version }}{{ end }}
{{- end -}}

{{/* Where the results storage is mounted (results.mountPath), without a trailing slash */}}
{{- define "qaboard.resultsPath" -}}
{{- $path := .Values.results.mountPath | trimSuffix "/" -}}
{{- if or (not (hasPrefix "/" $path)) (hasPrefix "/var/qaboard" $path) -}}
{{- fail (printf "results.mountPath must be an absolute folder, other than / and the backend's /var/qaboard, not %q" .Values.results.mountPath) -}}
{{- end -}}
{{- $path -}}
{{- end -}}

{{/* The volume of the results storage, mounted by the backend, the proxy and cantaloupe */}}
{{- define "qaboard.resultsVolume" -}}
{{- with .Values.results -}}
{{- if gt (len (compact (list .existingClaim (and .nfs "nfs") (and .hostPath "hostPath")))) 1 -}}
{{- fail "Set only one of results.existingClaim, results.nfs and results.hostPath" -}}
{{- end -}}
- name: qaboard-results
{{- if .existingClaim }}
  persistentVolumeClaim: {claimName: {{ .existingClaim }}}
{{- else if .nfs }}
  nfs: {{- toYaml .nfs | nindent 4 }}
{{- else if .hostPath }}
  hostPath:
    path: {{ required "Set results.hostPath.path" .hostPath.path }}
    type: {{ .hostPath.type | default "DirectoryOrCreate" }}
{{- else }}
  persistentVolumeClaim: {claimName: {{ include "qaboard.fullname" $ }}-results}
{{- end }}
{{- end }}
{{- end -}}

{{/* Where the demo data's results are: the path their database has (demoData) */}}
{{- define "qaboard.demoDataPath" -}}
{{- if and .Values.results.enabled (eq (include "qaboard.resultsPath" .) "/mnt/qaboard") -}}
{{- fail "demoData mounts the demo results at /mnt/qaboard: set results.mountPath to another folder" -}}
{{- end -}}
/mnt/qaboard
{{- end -}}

{{- define "qaboard.demoDataImage" -}}
{{- .Values.demoData.image | default (include "qaboard.image" (list . "demo-data")) -}}
{{- end -}}

{{/* The init container that restores the demo data. Usage: include "qaboard.demoDataRestore" (list . "all"|"database") */}}
{{- define "qaboard.demoDataRestore" -}}
{{- $ := index . 0 -}}
{{- $what := index . 1 -}}
- name: demo-data
  image: {{ include "qaboard.demoDataImage" $ }}
  imagePullPolicy: {{ $.Values.image.pullPolicy }}
  {{- if eq $what "database" }}
  # Only the database: the backend's init container restores the results
  args: ["database"]
  {{- end }}
  # The database settings, like the migrations Job's
  env: {{- include "qaboard.backendEnv" $ | nindent 4 }}
    {{- if not (or $.Values.database.cnpg.enabled $.Values.database.embedded.enabled) }}
    - name: QABOARD_DB_PASSWORD
      valueFrom: {secretKeyRef: {name: {{ include "qaboard.secretName" $ }}, key: QABOARD_DB_PASSWORD, optional: true}}
    {{- end }}
    - {name: QABOARD_DEMO_RESULTS, value: {{ include "qaboard.demoDataPath" $ | quote }}}
  {{- if ne $what "database" }}
  volumeMounts:
    - {name: demo-data, mountPath: {{ include "qaboard.demoDataPath" $ | quote }}}
  {{- end }}
{{- end -}}

{{/* RabbitMQ's account, as QABOARD_RABBITMQ_USER and QABOARD_RABBITMQ_PASSWORD: the env vars after them use $(...) */}}
{{- define "qaboard.rabbitmqCredentials" -}}
- name: QABOARD_RABBITMQ_USER
  value: {{ .Values.celery.rabbitmq.user | quote }}
{{- if .Values.celery.rabbitmq.passwordFromSecret }}
- name: QABOARD_RABBITMQ_PASSWORD
  valueFrom: {secretKeyRef: {name: {{ include "qaboard.secretName" . }}, key: QABOARD_RABBITMQ_PASSWORD}}
{{- else }}
- name: QABOARD_RABBITMQ_PASSWORD
  value: {{ .Values.celery.rabbitmq.password | quote }}
{{- end }}
{{- end -}}

{{- define "qaboard.secretName" -}}
{{- .Values.secret.existingSecret | default (printf "%s-secret" (include "qaboard.fullname" .)) -}}
{{- end -}}

{{- define "qaboard.dbHost" -}}
{{- if .Values.database.cnpg.enabled -}}
{{ include "qaboard.fullname" . }}-db-rw
{{- else if .Values.database.embedded.enabled -}}
{{ include "qaboard.fullname" . }}-db
{{- else -}}
{{ required "Set database.host, or enable database.cnpg or database.embedded" .Values.database.host }}
{{- end -}}
{{- end -}}

{{/* Environment shared by the backend, the migrations and flower */}}
{{- define "qaboard.backendEnv" -}}
- name: QABOARD_DB_HOST
  value: {{ include "qaboard.dbHost" . | quote }}
- name: QABOARD_DB_PORT
  value: {{ .Values.database.port | quote }}
- name: QABOARD_DB_NAME
  value: {{ .Values.database.name | quote }}
{{- if .Values.database.cnpg.enabled }}
# Created by CloudNativePG
- name: QABOARD_DB_USER
  valueFrom: {secretKeyRef: {name: {{ include "qaboard.fullname" . }}-db-app, key: username}}
- name: QABOARD_DB_PASSWORD
  valueFrom: {secretKeyRef: {name: {{ include "qaboard.fullname" . }}-db-app, key: password}}
{{- else }}
- name: QABOARD_DB_USER
  value: {{ .Values.database.user | quote }}
{{- if .Values.database.embedded.enabled }}
- name: QABOARD_DB_PASSWORD
  value: {{ .Values.database.embedded.password | quote }}
{{- end }}
{{- end }}
{{- if .Values.redis.enabled }}
- name: REDIS_HOST
  value: {{ include "qaboard.fullname" . }}-redis
- name: REDIS_PORT
  value: "6379"
{{- end }}
{{- if .Values.celery.enabled }}
{{ include "qaboard.rabbitmqCredentials" . }}
- name: CELERY_BROKER_URL
  value: pyamqp://$(QABOARD_RABBITMQ_USER):$(QABOARD_RABBITMQ_PASSWORD)@{{ include "qaboard.fullname" . }}-rabbitmq:5672//
{{- end }}
{{- with .Values.backend.env }}
{{ toYaml . }}
{{- end }}
{{- end -}}

{{- define "qaboard.backendEnvFrom" -}}
- configMapRef:
    name: {{ include "qaboard.fullname" . }}-config
- secretRef:
    name: {{ include "qaboard.secretName" . }}
{{- end -}}
