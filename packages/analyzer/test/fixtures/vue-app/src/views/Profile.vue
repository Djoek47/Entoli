<template>
  <section>
    <select v-model="settings.language">
      <option value="en">English</option>
      <option value="de">Deutsch</option>
    </select>
    <form @submit.prevent="savePassword">
      <input type="password" v-model="password" />
      <button type="submit">Save</button>
    </form>
  </section>
</template>

<script setup>
import { ref } from 'vue';
const password = ref('');
function savePassword() {}
</script>
